/**
 * popup.ts — Sonar popup v2
 *
 * Redesigned layout:
 *   ┌─ Header: SONAR + connection dot + host + DEV chip if localhost ─┐
 *   │  [📡 Pin current page]                                           │
 *   │  [paste URL…  ][Pin]                                             │
 *   ├─ Section: Active ────────────────────────────────────────────────┤
 *   │  Full stage rail — only for in-flight jobs                       │
 *   ├─ Section: Needs Review ──────────────────────────────────────────┤
 *   │  Compact amber row + [Open Radar] [Retry]                        │
 *   ├─ Section: Failed (collapsed by default if all > 5 min old) ──────┤
 *   │  Compact red row + [Retry on localhost] [Dismiss]                │
 *   ├─ Section: Recent ────────────────────────────────────────────────┤
 *   │  Compact green row — fades after a while                         │
 *   └─ Footer: Open Radar · Clear failed ─────────────────────────────┘
 *
 * Rules:
 *   - Stage rail only on Active jobs
 *   - Failed section collapsed by default when all failures > 5 min old
 *   - Retry button label says "Retry on localhost" vs "Retry on admin.amplifyit.io"
 *   - Login-page detection before Pin current page
 *   - DEV chip when host contains localhost or 127.0.0.1
 */

import type { StoredJob, LocalStatus } from './background';

// ── Constants ─────────────────────────────────────────────────────────────────
const STORAGE_JOBS_KEY = 'sonar_jobs';
const STORAGE_CFG_KEY  = 'sonar_config';
const DEFAULT_HOST     = 'https://admin.amplifyit.io';
const MAX_FEED_SHOWN   = 20;
const RECENT_FADE_MS   = 5 * 60 * 1000;   // completed jobs fade after 5 min
const FAILED_COLLAPSE_MS = 5 * 60 * 1000; // auto-collapse failed section after 5 min

interface Config { host: string; apiKey: string; liInline: boolean; }

// ── Status classification ─────────────────────────────────────────────────────
const IN_FLIGHT: Set<LocalStatus> = new Set(['sending', 'queued', 'fetching', 'classifying', 'resolving']);

function section(job: StoredJob): 'active' | 'review' | 'failed' | 'recent' {
  if (IN_FLIGHT.has(job.status))          return 'active';
  if (job.status === 'needs_review')      return 'review';
  if (job.status === 'completed')         return 'recent';
  return 'failed'; // failed | network_error | auth_required
}

// ── Storage ───────────────────────────────────────────────────────────────────
async function loadJobs(): Promise<StoredJob[]> {
  const r = await chrome.storage.local.get(STORAGE_JOBS_KEY) as { sonar_jobs?: StoredJob[] };
  return (r.sonar_jobs ?? []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function loadConfig(): Promise<Config> {
  const r = await chrome.storage.local.get([STORAGE_CFG_KEY, 'sonar_li_inline']) as {
    sonar_config?: Partial<Config> & { token?: string };
    sonar_li_inline?: boolean;
  };
  const cfg = r.sonar_config ?? {};
  return { host: cfg.host ?? DEFAULT_HOST, apiKey: cfg.apiKey ?? cfg.token ?? '', liInline: r.sonar_li_inline === true };
}

async function saveConfig(cfg: Config): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_CFG_KEY]: { host: cfg.host, apiKey: cfg.apiKey }, sonar_li_inline: cfg.liInline });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function qs<T extends HTMLElement>(sel: string): T { return document.querySelector<T>(sel) as T; }
function esc(s: string): string { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function ago(iso: string, captureCount?: number): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  let t: string;
  if (s < 5)     t = 'now';
  else if (s < 60)    t = `${s}s`;
  else if (s < 3600)  t = `${Math.floor(s / 60)}m`;
  else if (s < 86400) t = `${Math.floor(s / 3600)}h`;
  else                t = `${Math.floor(s / 86400)}d`;
  // Show dedup count: "3× · 5s"
  return captureCount && captureCount > 1 ? `${captureCount}× · ${t}` : t;
}

function isDevHost(host: string): boolean {
  return host.includes('localhost') || host.includes('127.0.0.1') || host.includes('0.0.0.0');
}

function shortHost(host: string): string {
  return host.replace(/^https?:\/\//, '').split('/')[0] ?? host;
}

function platformLabel(job: StoredJob): string {
  const sig = (job as StoredJob & { signal_type?: string }).signal_type;

  const SIG_LABEL: Record<string, string> = {
    hiring:         'Hiring',
    funding:        'Funding',
    product_launch: 'Launch',
    expansion:      'Expansion',
  };

  // Platform display
  const u = (job.url ?? '').toLowerCase();
  const platform =
    job.platform                                     ? job.platform.charAt(0).toUpperCase() + job.platform.slice(1) :
    u.includes('linkedin.com')                       ? 'LinkedIn' :
    u.includes('x.com') || u.includes('twitter.com') ? 'X' :
    u.includes('reddit.com')                          ? 'Reddit'  : 'Web';

  // Signal prefix when known: "Hiring · LinkedIn" > "linkedin · post"
  if (sig && SIG_LABEL[sig]) return `${SIG_LABEL[sig]} · ${platform}`;
  if (job.kind)               return `${job.kind.charAt(0).toUpperCase() + job.kind.slice(1)} · ${platform}`;
  return platform;
}

function cardTitle(job: StoredJob): string {
  return job.og_data?.title ?? job.page_title ?? job.author_hint ?? platformLabel(job);
}

function faviconUrl(job: StoredJob): string {
  try {
    const host = new URL(job.url.startsWith('http') ? job.url : `https://${job.url}`).hostname;
    return `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
  } catch { return ''; }
}

// ── Auth state ─────────────────────────────────────────────────────────────────
// Returns: 'ok' | 'no_key' | 'auth_failed'
function authState(jobs: StoredJob[], cfg: Config): 'ok' | 'no_key' | 'auth_failed' {
  if (!cfg.apiKey) return 'no_key';
  if (jobs.some(j => j.status === 'auth_required')) return 'auth_failed';
  return 'ok';
}

// ── Error messages ────────────────────────────────────────────────────────────
function terminalNote(job: StoredJob, hostLabel: string): string {
  if (job.status === 'auth_required') return 'Sign-in required — open Settings';

  if (job.status === 'needs_review') {
    if (job.error_code === 'STEALTH_ORG') return 'Building in stealth — no domain available. Saved for tracking.';
    // Surface the detected company name from the resolution note when available
    const note = job.resolution?.note ?? '';
    const companyMatch = note.match(/company "([^"]+)"/);
    const role = (job as StoredJob & { role_mentioned?: string }).role_mentioned;
    if (companyMatch) {
      return `Company detected · needs domain${role ? ` · ${role}` : ''}`;
    }
    return 'No company detected — open in Radar to assign manually.';
  }

  if (job.status === 'network_error' || job.status === 'failed') {
    const code = job.error_code;
    if (code === 'FETCH_BLOCKED')  return 'Page blocked scrapers — URL saved, no content extracted.';
    if (code === 'STEALTH_ORG')    return 'Building in stealth — no domain findable.';
    if (code === 'PIPELINE_ERROR') {
      const err = job.error ?? '';
      if (err.includes('500')) return `Backend error. Retry on ${hostLabel}.`;
      return `Processing failed. Retry on ${hostLabel}.`;
    }
    const err = job.error ?? '';
    if (err.includes('500')) return `Backend error. Retry on ${hostLabel}.`;
    if (err.includes('404')) return `Not found on backend. Is ${hostLabel} running?`;
    return err.slice(0, 80) || `Network error — retry on ${hostLabel}`;
  }
  return '';
}

// ── Stage rail (active jobs only) ─────────────────────────────────────────────
const STAGE_STEPS = [
  { key: 'sending',      label: 'Send'    },
  { key: 'queued',       label: 'Queue'   },
  { key: 'fetching',     label: 'Fetch'   },
  { key: 'classifying',  label: 'Read'    },
  { key: 'resolving',    label: 'Resolve' },
];

function stageIdx(status: string): number {
  const i = STAGE_STEPS.findIndex(s => s.key === status);
  return i >= 0 ? i : 0;
}

function stageLabel(status: string): string {
  if (status === 'sending')      return 'Sending…';
  if (status === 'queued')       return 'Queued';
  if (status === 'fetching')     return 'Fetching page…';
  if (status === 'classifying')  return 'Reading content…';
  if (status === 'resolving')    return 'Resolving org…';
  return status;
}

function renderRail(status: LocalStatus): string {
  const cur = stageIdx(status);
  const dots = STAGE_STEPS.map((s, i) => {
    let cls = 'sd';
    if (i < cur)  cls += ' sd-done';
    if (i === cur) cls += ' sd-active sd-pulse';
    return `<span class="${cls}"></span>`;
  }).join('<span class="sl"></span>');
  return `<div class="rail"><div class="rail-dots">${dots}</div><span class="rail-label">${esc(stageLabel(status))}</span></div>`;
}

// ── Card renderers ─────────────────────────────────────────────────────────────

function renderActiveCard(job: StoredJob): string {
  const title      = cardTitle(job);
  const sig        = (job as StoredJob & { signal_type?: string }).signal_type;
  // Pull tentative org name from extracted field when available — shows during processing
  const detectedOrg = (job as StoredJob & { extracted?: { tentative_org_name?: string | null } }).extracted?.tentative_org_name;

  // Context line: show exactly what the system is working on
  const contextParts: string[] = [];
  if (detectedOrg)    contextParts.push(`Resolving: ${detectedOrg}`);
  else if (sig)       contextParts.push(`Analyzing ${sig} signal…`);
  else                contextParts.push('Processing…');
  if (job.author_hint && !detectedOrg) contextParts.push(`by ${job.author_hint}`);

  return `
    <div class="card card-active">
      <div class="card-row">
        <span class="ic" style="color:var(--info)">⟳</span>
        <span class="card-favicon"><img src="${esc(faviconUrl(job))}" alt="" onerror="this.style.display='none'" /></span>
        <span class="card-title">${esc(title)}</span>
        <span class="card-meta-right">${esc(platformLabel(job))}</span>
        <span class="card-time">${ago(job.created_at, job.capture_count)}</span>
      </div>
      <div class="card-note" style="color:var(--info)">${esc(contextParts.join(' · '))}</div>
      ${renderRail(job.status)}
    </div>`;
}

function renderCompactCard(job: StoredJob, cfg: Config): string {
  const title    = cardTitle(job);
  const favicon  = faviconUrl(job);
  const note     = terminalNote(job, shortHost(cfg.host));
  const sec      = section(job);

  const icon = sec === 'review' ? '⚠' : sec === 'recent' ? '✓' : '✕';
  const iconCls  = sec === 'review' ? 'ic-warn' : sec === 'recent' ? 'ic-ok' : 'ic-err';

  // Org chip for completed/review with resolved org
  const orgChip = job.canonical_org_id
    ? `<span class="org-tag">${esc(job.canonical_org_id)}</span>`
    : '';

  // Action buttons
  let actions = '';
  if (job.watch_id && (sec === 'recent' || sec === 'review')) {
    actions += `<button class="btn-sm btn-open" data-open-radar="${esc(job.watch_id)}">Open in Radar →</button>`;
  }
  const retryLabel = isDevHost(cfg.host) ? 'Retry (dev)' : 'Retry';
  if (sec === 'failed' || sec === 'review') {
    actions += `<button class="btn-sm btn-retry" data-retry="${esc(job.local_id)}">${esc(retryLabel)}</button>`;
  }
  if (sec === 'failed') {
    actions += `<button class="btn-sm btn-dismiss" data-dismiss="${esc(job.local_id)}">Dismiss</button>`;
  }

  return `
    <div class="card card-compact" data-local-id="${esc(job.local_id)}">
      <div class="card-row">
        <span class="ic ${iconCls}">${icon}</span>
        <span class="card-favicon"><img src="${esc(favicon)}" alt="" onerror="this.style.display='none'" /></span>
        <a class="card-title card-link" href="${esc(job.url)}" target="_blank" rel="noopener">${esc(title)}</a>
        ${orgChip}
        <span class="card-meta-right">${esc(platformLabel(job))}</span>
        <span class="card-time">${ago(job.updated_at ?? job.created_at, job.capture_count)}</span>
      </div>
      ${note ? `<div class="card-note">${esc(note)}</div>` : ''}
      ${actions ? `<div class="card-actions">${actions}</div>` : ''}
      </div>`;
  }

// ── Section renderer ──────────────────────────────────────────────────────────

function renderSection(
  id: string, label: string, jobs: StoredJob[], cfg: Config,
  opts: { collapsed?: boolean; clearable?: boolean } = {},
): string {
  if (jobs.length === 0) return '';

  const cards = id === 'active'
    ? jobs.map(j => renderActiveCard(j)).join('')
    : jobs.map(j => renderCompactCard(j, cfg)).join('');

  const clearBtn = opts.clearable
    ? `<button class="sec-clear" data-clear="${id}">Clear</button>`
    : '';

  const collapseAttr = opts.collapsed ? ' data-collapsed="true"' : '';
  const chevron = opts.collapsed ? '▸' : '▾';

  return `
    <div class="section" id="sec-${id}"${collapseAttr}>
      <div class="sec-header" data-toggle="${id}">
        <span class="sec-chevron">${chevron}</span>
        <span class="sec-label">${esc(label)}</span>
        <span class="sec-count">${jobs.length}</span>
        ${clearBtn}
          </div>
      <div class="sec-body">${cards}</div>
    </div>`;
}

// ── Auth blocking overlay ─────────────────────────────────────────────────────
function renderAuthBlock(state: 'no_key' | 'auth_failed'): string {
  const title = state === 'no_key' ? 'Not connected' : 'API key rejected';
  const desc  = state === 'no_key'
    ? 'Set your API key in Settings to start capturing.'
    : 'Your key is invalid or expired. Update it in Settings.';
  return `
    <div class="auth-block">
      <div class="auth-block-icon">🔒</div>
      <div class="auth-block-title">${esc(title)}</div>
      <div class="auth-block-desc">${esc(desc)}</div>
      <button id="btn-open-config-2" class="btn btn-primary" style="margin-top:6px;padding:6px 14px;font-size:11px;border-radius:7px;">Fix in Settings</button>
    </div>`;
}

// ── Success flash (shown briefly when a new completed job appears) ─────────────
let _lastCompletedIds = new Set<string>();

function checkNewSuccess(jobs: StoredJob[], cfg: Config): void {
  const completed = jobs.filter(j => j.status === 'completed');
  for (const j of completed) {
    if (!_lastCompletedIds.has(j.local_id)) {
      const org   = j.canonical_org_id ? ` · ${j.canonical_org_id}` : '';
      showSuccessFlash(`✓ Saved to Radar${org}`);
    }
  }
  _lastCompletedIds = new Set(completed.map(j => j.local_id));
}

let _flashTimer: ReturnType<typeof setTimeout> | null = null;

function showSuccessFlash(msg: string): void {
  const el = document.getElementById('success-flash');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'flex';
  el.style.animation = 'none';
  void el.offsetWidth; // force reflow
  el.style.animation = 'flashIn 0.2s ease, flashOut 0.4s ease 3s forwards';
  if (_flashTimer) clearTimeout(_flashTimer);
  _flashTimer = setTimeout(() => { el.style.display = 'none'; }, 3600);
}

// ── Auth banner (passive, only for non-blocking case) ─────────────────────────
function renderAuthBanner(hasFailed: boolean, cfg: Config): string {
  if (!hasFailed && cfg.apiKey) return '';
  const msg = !cfg.apiKey
    ? 'No API key set — open Settings'
    : `Auth failed — check Settings`;
  return `<div class="auth-banner">🔑 ${esc(msg)} <button id="btn-open-config-2" class="btn-sm btn-warn">Settings</button></div>`;
}

// ── Full feed render ──────────────────────────────────────────────────────────
function renderFeed(jobs: StoredJob[], cfg: Config): void {
  const feed = qs<HTMLDivElement>('#feed');

  // Check for new completed jobs → success flash
  checkNewSuccess(jobs, cfg);

  // Auth blocking mode
  const auth = authState(jobs, cfg);
  const pinBtn = document.getElementById('btn-pin-page') as HTMLButtonElement | null;
  const urlIn  = document.getElementById('quick-url')   as HTMLInputElement | null;
  const capBtn = document.getElementById('btn-capture') as HTMLButtonElement | null;
  if (auth !== 'ok') {
    feed.innerHTML = renderAuthBlock(auth);
    feed.querySelector<HTMLButtonElement>('#btn-open-config-2')?.addEventListener('click', () => setTab('settings'));
    if (pinBtn) { pinBtn.disabled = true;  pinBtn.style.opacity = '0.5'; }
    if (urlIn)  { urlIn.disabled  = true; }
    if (capBtn) { capBtn.disabled = true; }
    return;
  } else {
    if (pinBtn) { pinBtn.disabled = false; pinBtn.style.opacity = ''; }
    if (urlIn)  { urlIn.disabled  = false; }
  }

  const active  = jobs.filter(j => section(j) === 'active');
  const review  = jobs.filter(j => section(j) === 'review');
  const recent  = jobs.filter(j => section(j) === 'recent').slice(0, 8);
  const failed  = jobs.filter(j => section(j) === 'failed');

  const allFailedOld = failed.length > 0 && failed.every(j =>
    Date.now() - new Date(j.updated_at).getTime() > FAILED_COLLAPSE_MS,
  );

  if (active.length + review.length + recent.length + failed.length === 0) {
    feed.innerHTML = `
      <div class="empty">
        <div class="empty-icon">📡</div>
        <div class="empty-text"><b>No captures yet.</b><br/>
          Click 📡 on any post, or use the button above.</div>
      </div>`;
    return;
  }

  feed.innerHTML =
    renderSection('active',  'Active',       active, cfg) +
    renderSection('review',  'Needs review', review, cfg, { clearable: false }) +
    renderSection('failed',  'Failed',       failed, cfg, { collapsed: allFailedOld, clearable: true }) +
    renderSection('recent',  'Recent',       recent, cfg, { collapsed: recent.length > 3 });

  // Update footer clear button visibility
  const clearFooterBtn = document.getElementById('btn-clear-failed');
  if (clearFooterBtn) clearFooterBtn.style.display = failed.length > 0 ? 'inline' : 'none';

  wireInteractions(feed, cfg);
}

function wireInteractions(feed: HTMLDivElement, cfg: Config): void {
  // Section collapse toggles
  feed.querySelectorAll<HTMLDivElement>('[data-toggle]').forEach(header => {
    header.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return; // let buttons handle themselves
      const id  = header.getAttribute('data-toggle');
      const sec = feed.querySelector<HTMLDivElement>(`#sec-${id}`);
      if (!sec) return;
      const collapsed = sec.dataset.collapsed === 'true';
      sec.dataset.collapsed = collapsed ? 'false' : 'true';
      header.querySelector('.sec-chevron')!.textContent = collapsed ? '▾' : '▸';
    });
  });

  // Open in Radar
  feed.querySelectorAll<HTMLButtonElement>('[data-open-radar]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const host = cfg.host.replace(/\/$/, '');
      await chrome.tabs.create({ url: `${host}/admin/gtm?tab=radar` });
      window.close();
    });
  });

  // Retry
  feed.querySelectorAll<HTMLButtonElement>('[data-retry]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      btn.textContent = '…';
      btn.disabled    = true;
      chrome.runtime.sendMessage({ type: 'RETRY_JOB', local_id: btn.getAttribute('data-retry') });
    });
  });

  // Dismiss (remove from list)
  feed.querySelectorAll<HTMLButtonElement>('[data-dismiss]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.getAttribute('data-dismiss');
      const card = btn.closest<HTMLDivElement>('.card');
      if (card) { card.style.opacity = '0'; card.style.transition = 'opacity 0.2s'; setTimeout(() => card.remove(), 200); }
      // Remove from storage
      const r = await chrome.storage.local.get(STORAGE_JOBS_KEY) as { sonar_jobs?: StoredJob[] };
      const updated = (r.sonar_jobs ?? []).filter(j => j.local_id !== id);
      await chrome.storage.local.set({ sonar_jobs: updated });
    });
  });

  // Clear section
  feed.querySelectorAll<HTMLButtonElement>('[data-clear]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const sectionId = btn.getAttribute('data-clear');
      if (sectionId === 'failed') {
        chrome.runtime.sendMessage({ type: 'CLEAR_FAILED' });
      }
    });
  });

  // Auth banner settings link
  feed.querySelector<HTMLButtonElement>('#btn-open-config-2')?.addEventListener('click', () => setTab('settings'));
}

// ── Header / settings render ──────────────────────────────────────────────────
function renderHeader(cfg: Config): void {
  const dev    = isDevHost(cfg.host);
  const hShort = shortHost(cfg.host);

  const dot   = qs<HTMLSpanElement>('#conn-dot');
  dot.className = cfg.apiKey ? 'dot-live connected' : 'dot-live disconnected';
  dot.title     = cfg.apiKey ? `Connected to ${hShort}` : 'No API key';

  const hostEl = qs<HTMLSpanElement>('#host-display');
  hostEl.textContent = hShort;

  const devChip = qs<HTMLSpanElement>('#dev-chip');
  if (devChip) {
    devChip.style.display = dev ? 'inline-flex' : 'none';
    devChip.title = 'Extension is sending captures to localhost, not production';
  }
}

function renderSettings(cfg: Config): void {
  qs<HTMLInputElement>('#cfg-host').value   = cfg.host;
  qs<HTMLInputElement>('#cfg-apikey').value = cfg.apiKey;
  const li = qs<HTMLInputElement>('#cfg-li-inline');
  if (li) li.checked = cfg.liInline;
  const openRadar = qs<HTMLAnchorElement>('#open-radar');
  openRadar.href = `${cfg.host.replace(/\/$/, '')}/admin/gtm`;
  renderHeader(cfg);
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function setTab(name: 'feed' | 'settings'): void {
  const isFeed = name === 'feed';
  qs<HTMLDivElement>('#feed-panel').style.display     = isFeed ? 'block' : 'none';
  qs<HTMLDivElement>('#settings-panel').style.display = isFeed ? 'none'  : 'block';
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name),
  );
}

// ── Capture quality assessment ────────────────────────────────────────────────
// Run BEFORE sending to backend. Block or warn based on signal quality.

interface CaptureQuality {
  ok:      boolean;   // send it
  block:   boolean;   // hard block — never capture this
  warn?:   string;    // soft warning — ask the user
}

const LOGIN_PATTERNS = /\b(log\s*in|sign\s*in|sign\s*up|auth|checkpoint|verify|captcha|two.?factor|password\s+reset)\b/i;
const LOW_SIGNAL_PATTERNS: Array<{ test: (url: string) => boolean; msg: string }> = [
  { test: u => /linkedin\.com\/(feed\/?|jobs\/?)?$/.test(u),         msg: 'LinkedIn feed detected — open a specific post or profile to get useful data.' },
  { test: u => /^https?:\/\/(www\.)?(x|twitter)\.com\/?$/.test(u),   msg: 'X home page — open a specific tweet or profile first.' },
  { test: u => /linkedin\.com\/notifications/.test(u),                msg: 'Notifications page — open the actual post or profile instead.' },
  { test: u => /linkedin\.com\/messaging/.test(u),                    msg: 'Messages page — capture a post or profile instead.' },
];

function assessCapture(url: string, title: string): CaptureQuality {
  // Hard block: login / auth pages — never useful, always noise
  if (LOGIN_PATTERNS.test(title) || LOGIN_PATTERNS.test(url)) {
    return { ok: false, block: true };
  }
  // Soft warn: low-signal pages
  for (const p of LOW_SIGNAL_PATTERNS) {
    if (p.test(url)) return { ok: false, block: false, warn: p.msg };
  }
  return { ok: true, block: false };
}

// ── URL validation ────────────────────────────────────────────────────────────
function isValidUrl(s: string): boolean {
  try { new URL(s.trim().startsWith('http') ? s.trim() : `https://${s.trim()}`); return true; }
  catch { return false; }
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init(): Promise<void> {
  let currentCfg = await loadConfig();
  const jobs     = await loadJobs();

  renderSettings(currentCfg);
  renderFeed(jobs, currentCfg);
  setTab('feed');

  // Keyboard shortcut hint
  const hint = qs<HTMLSpanElement>('#shortcut-hint');
  if (hint) {
  const isMac = navigator.platform.toUpperCase().includes('MAC');
    hint.textContent = isMac ? '⌘⇧Y · shortcut' : 'Alt+Shift+R · shortcut';
  chrome.commands?.getAll?.((cmds) => {
    const cmd = (cmds ?? []).find(c => c.name === 'capture-page');
      if (cmd?.shortcut) hint.textContent = `${cmd.shortcut} · shortcut`;
  });
  }

  // Tab buttons
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach(btn =>
    btn.addEventListener('click', () => setTab(btn.dataset.tab as 'feed' | 'settings')),
  );

  // ── Pin current page ──────────────────────────────────────────────────────
  const pinPageBtn = qs<HTMLButtonElement>('#btn-pin-page');
  pinPageBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url) return;

    const quality = assessCapture(tab.url, tab.title ?? '');

    // Hard block — never capture login/auth pages
    if (quality.block) {
      showCaptureWarning(
        '🚫 Login page detected',
        'Open the actual post or profile you want to capture, then click Pin.',
        null,
      );
      return;
    }

    // Soft warn — low-signal page, ask for confirmation
    if (!quality.ok && quality.warn) {
      showCaptureWarning('⚠ Low-signal page', quality.warn, async () => {
        await doPinPage(tab, pinPageBtn);
      });
      return;
    }

    await doPinPage(tab, pinPageBtn);
  });

  function showCaptureWarning(title: string, body: string, onConfirm: (() => void) | null): void {
    const warning = qs<HTMLDivElement>('#capture-warning');
    const warnTitle = qs<HTMLDivElement>('#warn-title');
    const warnBody  = qs<HTMLDivElement>('#warn-body');
    const warnConfirm = qs<HTMLButtonElement>('#btn-warn-confirm');
    const warnCancel  = qs<HTMLButtonElement>('#btn-warn-cancel');

    warnTitle.textContent = title;
    warnBody.textContent  = body;
    warnConfirm.style.display = onConfirm ? 'inline-block' : 'none';
    warning.style.display = 'flex';

    warnConfirm.onclick = () => { warning.style.display = 'none'; onConfirm?.(); };
    warnCancel.onclick  = () => { warning.style.display = 'none'; };
  }

  async function doPinPage(tab: chrome.tabs.Tab, btn: HTMLButtonElement): Promise<void> {
    btn.disabled    = true;
    btn.textContent = '⟳ Capturing…';
    try {
      await new Promise<void>(r =>
        chrome.runtime.sendMessage({ type: 'INGEST', payload: { url: tab.url, page_title: tab.title ?? '' } }, () => r()),
      );
      btn.textContent = '✓ Pinned!';
      setTimeout(() => { btn.textContent = '📡 Pin current page'; btn.disabled = false; }, 2000);
    } catch {
      btn.textContent = '📡 Pin current page';
      btn.disabled    = false;
    }
  }

  // ── URL input ─────────────────────────────────────────────────────────────
  const urlInput   = qs<HTMLInputElement>('#quick-url');
  const captureBtn = qs<HTMLButtonElement>('#btn-capture');
  const syncBtn    = () => { captureBtn.disabled = !isValidUrl(urlInput.value); };
  urlInput.addEventListener('input',  syncBtn);
  urlInput.addEventListener('paste',  () => requestAnimationFrame(syncBtn));
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !captureBtn.disabled) captureBtn.click(); });
  syncBtn();

  captureBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!isValidUrl(url)) return;
    captureBtn.disabled    = true;
    captureBtn.textContent = '…';
    await new Promise<void>(r =>
      chrome.runtime.sendMessage({ type: 'INGEST', payload: { url } }, () => r()),
    );
    urlInput.value         = '';
    captureBtn.textContent = 'Pin';
    captureBtn.disabled    = true;
  });

  // ── Clear failed ──────────────────────────────────────────────────────────
  qs<HTMLButtonElement>('#btn-clear-failed').addEventListener('click', () =>
    chrome.runtime.sendMessage({ type: 'CLEAR_FAILED' }),
  );

  // ── Settings Save ─────────────────────────────────────────────────────────
  const statusEl = qs<HTMLDivElement>('#cfg-status');
  const showSt   = (t: string, k: 'success' | 'error' | 'info') => {
    statusEl.style.display = 'block';
    statusEl.style.color   = k === 'success' ? 'var(--success)' : k === 'error' ? 'var(--error)' : 'var(--muted)';
    statusEl.textContent   = t;
  };
  const hideSt = () => { statusEl.style.display = 'none'; };

  qs<HTMLButtonElement>('#btn-save-cfg').addEventListener('click', async () => {
    const li = qs<HTMLInputElement>('#cfg-li-inline');
    const newCfg: Config = {
      host:     qs<HTMLInputElement>('#cfg-host').value.trim().replace(/\/$/, '') || DEFAULT_HOST,
      apiKey:   qs<HTMLInputElement>('#cfg-apikey').value.trim(),
      liInline: li?.checked === true,
    };
    await saveConfig(newCfg);
    currentCfg = newCfg;
    renderSettings(newCfg);
    renderFeed(await loadJobs(), newCfg);
    showSt('✓ Saved', 'success');
    setTimeout(() => { hideSt(); setTab('feed'); }, 1200);
  });

  qs<HTMLButtonElement>('#btn-cancel-cfg').addEventListener('click', () => { hideSt(); setTab('feed'); });

  qs<HTMLButtonElement>('#btn-validate-cfg').addEventListener('click', async () => {
    const li = qs<HTMLInputElement>('#cfg-li-inline');
    const newCfg: Config = {
      host:     qs<HTMLInputElement>('#cfg-host').value.trim().replace(/\/$/, '') || DEFAULT_HOST,
      apiKey:   qs<HTMLInputElement>('#cfg-apikey').value.trim(),
      liInline: li?.checked === true,
    };
    if (!newCfg.apiKey) { showSt('Enter an API key first', 'error'); return; }
    await saveConfig(newCfg);
    currentCfg = newCfg;
    renderSettings(newCfg);
    showSt('Validating…', 'info');
    chrome.runtime.sendMessage({ type: 'CHECK_CONNECTION' }, (res: { ok: boolean; reason?: string; message?: string }) => {
      if (chrome.runtime.lastError) { showSt('Extension error', 'error'); return; }
      if (res.ok)                           showSt(`✓ Connected to ${shortHost(newCfg.host)}`, 'success');
      else if (res.reason === 'unauthorized') showSt('✗ Key rejected', 'error');
      else if (res.reason === 'network')      showSt(`✗ Network: ${res.message ?? ''}`, 'error');
      else                                    showSt(`✗ ${res.message ?? 'Failed'}`, 'error');
    });
  });

  // ── Live updates ──────────────────────────────────────────────────────────
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_JOBS_KEY]) {
      const next = (changes[STORAGE_JOBS_KEY].newValue as StoredJob[] | undefined) ?? [];
      renderFeed(next.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)), currentCfg);
    }
    if (changes[STORAGE_CFG_KEY]) {
      void loadConfig().then(c => { currentCfg = c; renderSettings(c); });
    }
  });

  // Time-ago tick every 30s (less aggressive than before)
  setInterval(async () => {
    if (document.querySelector<HTMLButtonElement>('.tab.active')?.dataset.tab !== 'feed') return;
    renderFeed(await loadJobs(), currentCfg);
  }, 30_000);
}

document.addEventListener('DOMContentLoaded', () => { void init(); });
