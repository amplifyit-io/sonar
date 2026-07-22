/**
 * background.ts — Sonar service worker
 *
 * Architecture: three stages per capture.
 *
 *   [1] ingest  →  POST /radar/ingest  → returns job_id (202 Accepted)
 *   [2] poll    →  GET /radar/jobs/:id every ~2s until terminal status
 *   [3] finish  →  status is completed | needs_review | failed  → stop polling
 *
 * Why polling (chrome.alarms) not setInterval:
 *   - Service workers in MV3 are terminated after ~30s idle.
 *   - Alarms persist across worker restarts and wake the worker automatically.
 *
 * All state lives in chrome.storage.local so the popup + content script can
 * read it directly without ever waking the service worker.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type Purpose  = 'manual_radar' | 'trigger_tracking' | 'competitor_tracking' | 'operator_tracking' | 'org_tracking';
export type Priority = 'low' | 'medium' | 'high';

/** Backend job statuses (see web/src/app/api/admin/gtm/radar/ingest/route.ts) */
export type BackendStatus =
  | 'queued' | 'fetching' | 'classifying' | 'resolving'
  | 'completed' | 'needs_review' | 'failed';

export type LocalStatus =
  | 'sending'              // local: HTTP request in flight
  | 'network_error'        // local: DNS/timeout after retries
  | 'auth_required'        // local: HTTP 401 — user must sign in to admin
  | BackendStatus;         // mirrored from backend once accepted

export interface IngestPayload {
  url:              string;
  platform?:        'x' | 'linkedin' | 'reddit' | 'web';
  kind?:            'post' | 'profile' | 'article' | 'page';
  purpose?:         Purpose;
  priority?:        Priority;
  page_title?:      string;
  visible_text?:    string;
  author_hint?:     string;
  author_url_hint?: string;
  post_url_hint?:   string;
  selected_text?:   string;
  captured_at?:     string;
}

/** OG metadata extracted by backend */
interface OGData {
  title?:       string | null;
  description?: string | null;
  author?:      string | null;
  image?:       string | null;
}

interface Resolution {
  org_status?:  string;
  lead_status?: string;
  note?:        string;
}

/** One capture row in the popup feed. Same shape used by popup + content script. */
export interface StoredJob {
  /** Local ID (created at ingest time, stable across retries) */
  local_id:     string;
  /** Backend ID — present once POST /ingest returns */
  job_id?:      string;
  url:          string;
  purpose:      Purpose;
  priority:     Priority;
  status:       LocalStatus;
  created_at:   string;
  updated_at:   string;
  retries:      number;
  error?:       string;

  /** Rich data fetched from the backend */
  og_data?:          OGData;
  resolution?:       Resolution;
  canonical_org_id?: string;
  is_refresh?:       boolean;
  watch_id?:         string;

  /** Cached for optimistic render before og_data arrives */
  page_title?:      string;
  selected_text?:   string;
  platform?:        string;
  kind?:            string;
  author_hint?:     string;
  author_url_hint?: string;
  visible_text?:    string;
  error_code?:      string;   // structured code from backend (FETCH_BLOCKED, etc.)
  capture_count?:   number;   // incremented each time the same URL is captured again
}

interface BackgroundConfig {
  host:    string;
  apiKey:  string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_HOST     = 'https://admin.amplifyit.io';
const INGEST_PATH      = '/api/admin/gtm/radar/ingest';
const JOB_PATH         = (id: string) => `/api/admin/gtm/radar/jobs/${id}`;
const MAX_INGEST_RETRIES = 3;
const POLL_INTERVAL_MIN  = 0.04;    // ~2.4s (chrome.alarms minimum is 0.5 in prod, 0.01 when unpacked — we keep it explicit)
const MAX_POLL_ATTEMPTS  = 60;      // ≈ 2 min total
const STORAGE_JOBS_KEY   = 'sonar_jobs';
const STORAGE_CFG_KEY    = 'sonar_config';
const STORAGE_POLL_KEY   = 'sonar_poll_state';  // { [local_id]: { attempts } }

// ── Config ────────────────────────────────────────────────────────────────────

async function getConfig(): Promise<BackgroundConfig> {
  const r = await chrome.storage.local.get(STORAGE_CFG_KEY) as {
    sonar_config?: Partial<BackgroundConfig> & { token?: string };
  };
  const cfg = r.sonar_config ?? {};
  return {
    host:   cfg.host   ?? DEFAULT_HOST,
    // Migrate legacy `token` field → apiKey (one-time, transparent)
    apiKey: cfg.apiKey ?? cfg.token ?? '',
  };
}

// ── Jobs persistence ──────────────────────────────────────────────────────────

async function loadJobs(): Promise<StoredJob[]> {
  const r = await chrome.storage.local.get(STORAGE_JOBS_KEY) as { sonar_jobs?: StoredJob[] };
  return r.sonar_jobs ?? [];
}

async function saveJobs(jobs: StoredJob[]): Promise<void> {
  const trimmed = jobs
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 50);
  await chrome.storage.local.set({ [STORAGE_JOBS_KEY]: trimmed });
}

async function updateJob(local_id: string, patch: Partial<StoredJob>): Promise<StoredJob | null> {
  const jobs = await loadJobs();
  const idx  = jobs.findIndex(j => j.local_id === local_id);
  if (idx === -1) return null;
  const updated: StoredJob = { ...jobs[idx], ...patch, updated_at: new Date().toISOString() };
  jobs[idx] = updated;
  await saveJobs(jobs);
  await refreshBadge();
  return updated;
}

// ── Poll state ────────────────────────────────────────────────────────────────

async function getPollState(): Promise<Record<string, { attempts: number }>> {
  const r = await chrome.storage.local.get(STORAGE_POLL_KEY) as { sonar_poll_state?: Record<string, { attempts: number }> };
  return r.sonar_poll_state ?? {};
}

async function setPollState(state: Record<string, { attempts: number }>): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_POLL_KEY]: state });
}

// ── Badge ─────────────────────────────────────────────────────────────────────

async function refreshBadge(): Promise<void> {
  const jobs = await loadJobs();
  const inflight = jobs.filter(j =>
    j.status === 'sending' || j.status === 'queued' ||
    j.status === 'fetching' || j.status === 'classifying' || j.status === 'resolving',
  ).length;
  const failed = jobs.filter(j =>
    j.status === 'failed' || j.status === 'network_error' || j.status === 'auth_required',
  ).length;

  if (failed > 0) {
    chrome.action.setBadgeText({ text: `!${failed}` });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else if (inflight > 0) {
    chrome.action.setBadgeText({ text: String(inflight) });
    chrome.action.setBadgeBackgroundColor({ color: '#111111' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function apiFetch(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
  const cfg  = await getConfig();
  const url  = pathOrUrl.startsWith('http') ? pathOrUrl : `${cfg.host}${pathOrUrl}`;
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (cfg.apiKey) headers.set('X-Api-Key', cfg.apiKey);

  const method = init.method ?? 'GET';
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    console.error('[Sonar API] request failed', { method, url, error: String(err) });
    throw err;
  }

  // Log every response so the service worker inspector shows exactly which
  // route is 500ing and what the response body contains.
  if (!res.ok) {
    const body = await res.clone().text().catch(() => '(unreadable)');
    console.error('[Sonar API] non-2xx response', {
      method,
      url,
      status: res.status,
      body:   body.slice(0, 300),
    });
  } else {
    console.info('[Sonar API] ok', { method, url, status: res.status });
  }

  return res;
}

// ── Core: ingest → poll pipeline ──────────────────────────────────────────────

function newLocalId(): string {
  return `lid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function ingest(payload: IngestPayload): Promise<void> {
  const jobs = await loadJobs();

  // Dedup: if the same URL was captured in the last 24h, refresh instead of creating a new job
  const normalizedUrl = (() => {
    try {
      const u = new URL(payload.url.startsWith('http') ? payload.url : `https://${payload.url}`);
      ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','rcm','fbclid','s','t'].forEach(p => u.searchParams.delete(p));
      return u.toString();
    } catch { return payload.url; }
  })();
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const existing = jobs.find(j => {
    try {
      const u = new URL(j.url.startsWith('http') ? j.url : `https://${j.url}`);
      ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','rcm','fbclid','s','t'].forEach(p => u.searchParams.delete(p));
      return u.toString() === normalizedUrl && new Date(j.created_at).getTime() > oneDayAgo;
    } catch { return j.url === normalizedUrl; }
  });

  if (existing) {
    console.info('[Sonar] dedup: refreshing existing capture for', normalizedUrl.slice(0, 80));
    existing.updated_at    = new Date().toISOString();
    existing.capture_count = (existing.capture_count ?? 1) + 1;
    existing.retries       = 0;
    await saveJobs(jobs);
    await refreshBadge();
    return;
  }

  // 1. Optimistic insert — popup sees the capture instantly
  const job: StoredJob = {
    local_id:     newLocalId(),
    url:          payload.url,
    purpose:      payload.purpose  ?? 'manual_radar',
    priority:     payload.priority ?? 'medium',
    status:       'sending',
    created_at:   new Date().toISOString(),
    updated_at:   new Date().toISOString(),
    retries:      0,
    page_title:   payload.page_title,
    selected_text: payload.selected_text,
    platform:        payload.platform,
    kind:            payload.kind,
    author_hint:     payload.author_hint,
    author_url_hint: payload.author_url_hint,
    visible_text:    payload.visible_text,
  };
  // Reuse the already-loaded jobs array from the dedup check above
  jobs.unshift(job);
  await saveJobs(jobs);

  // 2. Send to backend
  await sendIngest(job);
}

async function sendIngest(job: StoredJob): Promise<void> {
  let res: Response;
  try {
    res = await apiFetch(INGEST_PATH, {
      method: 'POST',
      body:   JSON.stringify({
        url:           job.url,
        purpose:       job.purpose,
        priority:      job.priority,
        requested_by:  'sonar',
        platform:      job.platform,
        kind:          job.kind,
        page_title:    job.page_title,
        visible_text:    job.visible_text,
        author_hint:     job.author_hint,
        author_url_hint: job.author_url_hint,
        selected_text:   job.selected_text,
      }),
    });
  } catch (err) {
    // Genuine network failure — DNS, timeout, offline. These are retriable.
    const retries = job.retries + 1;
    if (retries >= MAX_INGEST_RETRIES) {
      await updateJob(job.local_id, { status: 'network_error', retries, error: friendlyError(err) });
      notifyFailure(job.url, friendlyError(err));
    } else {
      await updateJob(job.local_id, { status: 'sending', retries, error: friendlyError(err) });
      const delayMs = [5_000, 15_000, 45_000][retries - 1] ?? 45_000;
      chrome.alarms.create(`ingest_${job.local_id}`, { when: Date.now() + delayMs });
    }
    return;
  }

  // HTTP error — fail fast, do NOT retry. A 401 or 404 will fail the same way
  // 100% of the time. Retrying just adds noise and 60s of glitching.
  if (!res.ok) {
    const text    = await res.text().catch(() => res.statusText);
    const looksLikeHtml = text.trimStart().startsWith('<');
    const body    = looksLikeHtml ? res.statusText : text.slice(0, 140);

    if (res.status === 401 || res.status === 403 || /Invalid IAP/i.test(text)) {
      await updateJob(job.local_id, {
        status: 'auth_required',
        error:  'API key invalid or missing — open Config and paste a valid key.',
      });
      return;
    }
    if (res.status === 404) {
      await updateJob(job.local_id, {
        status: 'network_error',
        error:  `Endpoint not found — check host in Config (${INGEST_PATH} missing on server).`,
      });
      return;
    }
    await updateJob(job.local_id, {
      status: 'network_error',
      error:  `HTTP ${res.status}: ${body}`,
    });
    return;
  }

  // Success — start polling backend status
  const data = await res.json() as { job_id: string; status?: BackendStatus };
  await updateJob(job.local_id, {
    job_id: data.job_id,
    status: data.status ?? 'queued',
    error:  undefined,
  });
  await schedulePoll(job.local_id, /* initialDelayMs */ 1500);
}

function friendlyError(err: unknown): string {
  const s = String(err);
  if (s.includes('TimeoutError') || s.includes('timeout'))    return 'Request timed out — check network';
  if (s.includes('Failed to fetch') || s.includes('Network')) return 'Network error — offline or DNS failed';
  return s.slice(0, 140);
}

// ── Polling ───────────────────────────────────────────────────────────────────

async function schedulePoll(local_id: string, delayMs = 2000): Promise<void> {
  const state = await getPollState();
  state[local_id] = state[local_id] ?? { attempts: 0 };
  await setPollState(state);
  chrome.alarms.create(`poll_${local_id}`, { when: Date.now() + delayMs });
}

async function pollJob(local_id: string): Promise<void> {
  const jobs    = await loadJobs();
  const job     = jobs.find(j => j.local_id === local_id);
  const state   = await getPollState();
  const attempt = (state[local_id]?.attempts ?? 0) + 1;

  if (!job || !job.job_id) { delete state[local_id]; await setPollState(state); return; }

  state[local_id] = { attempts: attempt };
  await setPollState(state);

  try {
    const res = await apiFetch(JOB_PATH(job.job_id), { method: 'GET' });

    if (res.status === 401) {
      await updateJob(local_id, { status: 'auth_required', error: 'IAP session expired — sign in again.' });
      delete state[local_id];
      await setPollState(state);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = await res.json() as any;

    const patch: Partial<StoredJob> = {
      status:           b.status,
      og_data:          b.og_data,
      resolution:       b.resolution,
      canonical_org_id: b.canonical_org_id,
      is_refresh:       b.is_refresh,
      watch_id:         b.watch_id,
      error:            b.error,
      error_code:       b.error_code,
    };
    await updateJob(local_id, patch);

    const terminal = b.status === 'completed' || b.status === 'needs_review' || b.status === 'failed';
    if (terminal || attempt >= MAX_POLL_ATTEMPTS) {
      delete state[local_id];
      await setPollState(state);
      return;
    }
    chrome.alarms.create(`poll_${local_id}`, { delayInMinutes: POLL_INTERVAL_MIN });

  } catch (err) {
    // Transient error — continue until attempts exhausted
    if (attempt >= MAX_POLL_ATTEMPTS) {
      await updateJob(local_id, { status: 'network_error', error: friendlyError(err) });
      delete state[local_id];
      await setPollState(state);
    } else {
      chrome.alarms.create(`poll_${local_id}`, { delayInMinutes: POLL_INTERVAL_MIN });
    }
  }
}

// ── Alarm dispatcher ─────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith('poll_')) {
    const id = alarm.name.slice(5);
    void pollJob(id);
    return;
  }
  if (alarm.name.startsWith('ingest_')) {
    const id   = alarm.name.slice(7);
    const jobs = await loadJobs();
    const job  = jobs.find(j => j.local_id === id);
    if (job && job.status === 'sending') void sendIngest(job);
    return;
  }
});

// ── Notifications ─────────────────────────────────────────────────────────────

function notifyFailure(url: string, reason: string): void {
  chrome.notifications.create({
    type:    'basic',
    iconUrl: 'icons/icon48.png',
    title:   'Sonar — Capture failed',
    message: `${url.slice(0, 60)}\n${reason.slice(0, 80)}`,
  });
}

// ── Keyboard shortcut ─────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-page') return;
  // lastFocusedWindow: true avoids the case where the extension side-panel or
  // popup is focused — those are not browser tabs and currentWindow returns empty.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url) return;

  // Ask content script for page context (visible_text, author hints).
  // Falls back gracefully if content script isn't injected (e.g. chrome:// pages).
  let ctx: Partial<IngestPayload> = {};
  if (tab.id != null) {
    ctx = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CAPTURE_CONTEXT' })
      .catch(() => ({}));
  }

  void ingest({
    url:             tab.url,
    purpose:         guessPurpose(tab.url),
    priority:        guessPriority(tab.url),
    page_title:      tab.title,
    visible_text:    ctx.visible_text,
    author_hint:     ctx.author_hint,
    author_url_hint: ctx.author_url_hint,
    platform:        ctx.platform,
    kind:            ctx.kind,
  });
  if (tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'SHOW_TOAST', text: 'Pinned to Radar', ok: true })
      .catch(() => {/* ignore */});
  }
});

// ── Context menu ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:       'sonar_ingest',
    title:    '📡 Send to Radar',
    contexts: ['page', 'link', 'selection'],
  });
  chrome.action.setBadgeText({ text: '' });

  // Use Side Panel as the primary Sonar surface.
  // Clicking the toolbar icon opens the panel so it stays visible while browsing.
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {/* API not available in this Chrome version */});
  }
});

// ── SPA navigation detection ─────────────────────────────────────────────────
// LinkedIn / X / Reddit use pushState for client-side routing. The content
// script can't reliably detect those from inside. webNavigation fires for
// every history change AFTER the URL has updated — we tell the content
// script to re-run its injector.

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;  // only top frame
  const host = (() => {
    try { return new URL(details.url).hostname; } catch { return ''; }
  })();
  if (!/(linkedin|x|twitter|reddit)\.com$/.test(host)) return;
  chrome.tabs.sendMessage(details.tabId, { type: 'NAVIGATE' })
    .catch(() => {/* tab may not yet have content script */});
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'sonar_ingest') return;
  const url = (info.linkUrl ?? info.pageUrl ?? tab?.url ?? '').trim();
  if (!url) return;

  // Ask content script for page context. On a link right-click we still want
  // whatever text + author the current page has (the link target isn't loaded).
  let ctx: Partial<IngestPayload> = {};
  if (tab?.id != null) {
    ctx = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CAPTURE_CONTEXT' })
      .catch(() => ({}));
  }

  // If the user right-clicked selected text, prefer that over extracted text
  const selected_text = info.selectionText?.trim() || undefined;

  void ingest({
    url,
    purpose:         guessPurpose(url),
    priority:        guessPriority(url),
    page_title:      tab?.title,
    visible_text:    ctx.visible_text,
    author_hint:     ctx.author_hint,
    author_url_hint: ctx.author_url_hint,
    platform:        ctx.platform,
    kind:            ctx.kind,
    selected_text,
  });
  if (tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'SHOW_TOAST', text: 'Pinned to Radar', ok: true })
      .catch(() => {/* ignore */});
  }
});

// ── Messages from content script / popup ─────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as { type: string; payload?: IngestPayload };

  if (m.type === 'INGEST' && m.payload) {
    void ingest(m.payload).then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (m.type === 'RETRY_JOB') {
    const id = (msg as { type: string; local_id: string }).local_id;
    void loadJobs().then(jobs => {
      const j = jobs.find(x => x.local_id === id);
      if (j) { j.retries = 0; j.status = 'sending'; j.error = undefined; void saveJobs(jobs).then(() => sendIngest(j)); }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (m.type === 'RETRY_ALL') {
    void loadJobs().then(async jobs => {
      const needsRetry = jobs.filter(j =>
        j.status === 'auth_required' || j.status === 'network_error' || j.status === 'failed',
      );
      for (const j of needsRetry) {
        j.retries = 0;
        j.status  = 'sending';
        j.error   = undefined;
      }
      await saveJobs(jobs);
      for (const j of needsRetry) void sendIngest(j);
      sendResponse({ ok: true, count: needsRetry.length });
    });
    return true;
  }

  if (m.type === 'CHECK_CONNECTION') {
    void (async () => {
      const cfg = await getConfig();
      if (!cfg.apiKey) {
        sendResponse({ ok: false, reason: 'no_key', message: 'No API key set' });
        return;
      }
      try {
        // HEAD the ingest endpoint — cheap, no side-effect. 404/405 means
        // "auth worked but method not allowed" → connection OK.
        const res = await apiFetch(INGEST_PATH, { method: 'OPTIONS' });
        if (res.status === 401 || res.status === 403) {
          sendResponse({ ok: false, reason: 'unauthorized', message: `HTTP ${res.status}` });
        } else if (res.status >= 500) {
          sendResponse({ ok: false, reason: 'server_error', message: `HTTP ${res.status}` });
        } else {
          sendResponse({ ok: true, status: res.status });
        }
      } catch (err) {
        sendResponse({ ok: false, reason: 'network', message: friendlyError(err) });
      }
    })();
    return true;
  }

  if (m.type === 'CLEAR_ALL') {
    void chrome.storage.local.set({ [STORAGE_JOBS_KEY]: [] })
      .then(() => refreshBadge())
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (m.type === 'CLEAR_FAILED') {
    void loadJobs()
      .then(jobs => saveJobs(jobs.filter(j => j.status !== 'failed' && j.status !== 'network_error')))
      .then(() => refreshBadge())
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

// ── Heuristics ────────────────────────────────────────────────────────────────

function guessPurpose(url: string): Purpose {
  const u = url.toLowerCase();
  if (u.includes('linkedin.com/company'))               return 'org_tracking';
  if (u.includes('linkedin.com/in'))                    return 'operator_tracking';
  if (u.includes('x.com') || u.includes('twitter.com')) return 'trigger_tracking';
  return 'manual_radar';
}

function guessPriority(url: string): Priority {
  const u = url.toLowerCase();
  if (u.includes('linkedin.com/in') || u.includes('/status/')) return 'high';
  return 'medium';
}
