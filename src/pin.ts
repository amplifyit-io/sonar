/**
 * pin.ts — Sonar pin button + Shadow DOM overlay layer.
 *
 * Two isolation layers:
 *
 *   1. Pin buttons are inline DOM elements injected into the host page.
 *      They use a highly-specific `.sonar-pin` class prefix and minimal CSS
 *      so they participate correctly in the host page's flex/layout.
 *
 *   2. Toast notifications and any modal overlay render inside a Shadow DOM
 *      root (`#sonar-overlay-host`) appended to <html>. This ensures:
 *        - our CSS cannot bleed into LinkedIn/X/Reddit
 *        - their CSS cannot break our overlay
 *        - z-index is isolated in the shadow stacking context
 *
 * The pin button itself is deliberately NOT in Shadow DOM: it needs to
 * participate in the host page's flex action-row layout.
 */

import type { Purpose, Priority } from './background';
import type { SonarCapture } from './injectors/types';

export interface PinOptions {
  /** Pre-computed capture. Called at inject time, not at click time. */
  capture:  SonarCapture;
  /** Platform-specific style variant */
  variant?: 'default' | 'x' | 'reddit' | 'reddit-old';
}

// ── Shadow DOM overlay root ───────────────────────────────────────────────────

const OVERLAY_HOST_ID = 'sonar-overlay-host';

let _shadow: ShadowRoot | null = null;

function getOrCreateShadow(): ShadowRoot {
  if (_shadow) return _shadow;

  let host = document.getElementById(OVERLAY_HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = OVERLAY_HOST_ID;
    // Append to <html> so it sits outside <body> stacking contexts
    document.documentElement.appendChild(host);
  }

  _shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;
  _shadow.appendChild(style);

  return _shadow;
}

const OVERLAY_CSS = `
  :host {
    all: initial;
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 2147483647;
  }

  #sonar-toast {
    position: fixed;
    bottom: 22px;
    right: 18px;
    background: #111;
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 12px;
    font-weight: 600;
    padding: 8px 13px;
    border-radius: 9px;
    box-shadow: 0 3px 14px rgba(0,0,0,0.25);
    display: flex;
    align-items: center;
    gap: 7px;
    max-width: 300px;
    pointer-events: none;
    animation: toast-in 0.18s ease forwards,
               toast-out 0.25s 2.4s ease forwards;
  }

  #sonar-toast .r-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  @keyframes toast-in {
    from { opacity: 0; transform: translateY(6px) scale(0.96); }
    to   { opacity: 1; transform: none; }
  }
  @keyframes toast-out {
    to { opacity: 0; transform: translateY(-4px); }
  }
`;

// ── Per-post pin button CSS (injected once into document.head) ────────────────

export function ensurePinStyles(): void {
  if (document.getElementById('sonar-pin-css')) return;
  const s = document.createElement('style');
  s.id = 'sonar-pin-css';
  s.textContent = `
    button.sonar-pin {
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      width: 28px; height: 28px;
      padding: 0;
      border: none;
      border-radius: 6px;
      background: transparent;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      color: #555;
      opacity: 0.35;
      transition: opacity 0.15s, background 0.15s;
      flex-shrink: 0;
      vertical-align: middle;
      outline: none;
      box-shadow: none;
    }
    button.sonar-pin:hover { opacity: 1; background: rgba(0,0,0,0.06); }
    button.sonar-pin:focus-visible { outline: 2px solid #111; outline-offset: 1px; }
    button.sonar-pin.sonar-busy    { opacity: 0.5; pointer-events: none; cursor: default; }
    button.sonar-pin.sonar-queued  { opacity: 1; color: #2563eb; animation: _sonar-blink 1.1s ease-in-out infinite; }
    button.sonar-pin.sonar-done    { opacity: 1; color: #15803d; }
    button.sonar-pin.sonar-review  { opacity: 1; color: #d97706; }
    button.sonar-pin.sonar-auth    { opacity: 1; color: #dc2626; }

    button.sonar-pin.v-x       { width: 34px; height: 34px; font-size: 15px; border-radius: 50%; }
    button.sonar-pin.v-x:hover { background: rgba(29,155,240,0.10); color: #1d9bf0; }

    button.sonar-pin.v-reddit     { color: #7c7c83; }
    button.sonar-pin.v-reddit-old {
      width: auto; height: auto;
      padding: 2px 6px; border-radius: 3px;
      font-size: 10px; font-weight: 700;
      color: #878a8c; opacity: 0.7;
    }

    @keyframes _sonar-blink {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.4; }
    }
  `;
  document.head.appendChild(s);
}

// ── Toast (rendered inside Shadow DOM) ───────────────────────────────────────

let _toastEl: HTMLDivElement | null = null;

export function toast(text: string, ok = true): void {
  const shadow = getOrCreateShadow();

  if (_toastEl) { _toastEl.remove(); _toastEl = null; }

  const el   = document.createElement('div');
  el.id      = 'sonar-toast';
  const dot  = document.createElement('span');
  dot.className = 'r-dot';
  dot.style.background = ok ? '#4ade80' : '#f87171';
  el.appendChild(dot);
  el.appendChild(document.createTextNode(text));
  shadow.appendChild(el);
  _toastEl = el;
  setTimeout(() => { el.remove(); if (_toastEl === el) _toastEl = null; }, 2800);
}

// ── URL cleaner ───────────────────────────────────────────────────────────────

const TRACKING_PARAMS = [
  'utm_source','utm_medium','utm_campaign','utm_content','utm_term',
  'rcm','fbclid','igshid','s','t','ref',
];

export function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    return u.toString();
  } catch { return raw; }
}

// ── Ingest dispatcher (content script → background) ───────────────────────────

export interface ExtIngestPayload {
  url:              string;
  platform:         SonarCapture['platform'];
  kind:             SonarCapture['kind'];
  page_title:       string;
  visible_text?:    string;
  author_hint?:     string;
  author_url_hint?: string;
  post_url_hint?:   string;
  selected_text?:   string;
  captured_at:      string;
  // Legacy fields kept for background.ts compatibility
  purpose:          Purpose;
  priority:         Priority;
}

function buildPayload(cap: SonarCapture): ExtIngestPayload {
  return {
    ...cap,
    purpose:  guessPurpose(cap),
    priority: guessPriority(cap),
  };
}

function guessPurpose(cap: SonarCapture): Purpose {
  if (cap.platform === 'linkedin') {
    if (cap.kind === 'profile') return 'operator_tracking';
    if (cap.kind === 'page')    return 'org_tracking';
  }
  if (cap.platform === 'x') return 'trigger_tracking';
  return 'manual_radar';
}

function guessPriority(cap: SonarCapture): Priority {
  if (cap.kind === 'profile' || cap.platform === 'x') return 'high';
  return 'medium';
}

function dispatchCapture(cap: SonarCapture): Promise<boolean> {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      { type: 'INGEST', payload: buildPayload(cap) },
      res => resolve(!chrome.runtime.lastError && (res as { ok?: boolean })?.ok === true),
    );
  });
}

// ── Job completion watcher ────────────────────────────────────────────────────
// Returns rich resolution data so the pin can show "Saved · acme.com"
// Calls onProgress for intermediate stages so the pin shows live state labels.

export type Terminal = 'completed' | 'needs_review' | 'failed' | 'auth_required' | 'timeout';

export interface JobCompletion {
  terminal:   Terminal;
  org?:       string;
  note?:      string;
  watchId?:   string;
  errorCode?: string;
  isRefresh?: boolean;
}

function watchJob(
  url:        string,
  onProgress: (status: string) => void,
): Promise<JobCompletion> {
  return new Promise(resolve => {
    let done = false;
    const finish = (result: JobCompletion) => {
      if (done) return;
      done = true;
      chrome.storage.onChanged.removeListener(onChange);
      clearTimeout(timer);
      resolve(result);
    };

    // 90-second safety net
    const timer = setTimeout(() => finish({ terminal: 'timeout' }), 90_000);

    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local' || !changes.sonar_jobs) return;
      const jobs = (changes.sonar_jobs.newValue ?? []) as Array<{
        url:              string;
        status:           string;
        canonical_org_id?: string;
        watch_id?:         string;
        resolution?:      { note?: string };
        is_refresh?:      boolean;
        error_code?:      string;
      }>;
      const match = jobs.find(j => j.url === url);
      if (!match) return;

      // Surface every stage transition to the caller
      onProgress(match.status);

      switch (match.status) {
        case 'completed':
          return finish({
            terminal:  'completed',
            org:       match.canonical_org_id,
            watchId:   match.watch_id,
            note:      match.resolution?.note,
            isRefresh: match.is_refresh,
          });
        case 'needs_review':
          return finish({
            terminal:   'needs_review',
            watchId:    match.watch_id,
            note:       match.resolution?.note,
            errorCode:  match.error_code,
          });
        case 'auth_required':
          return finish({ terminal: 'auth_required', errorCode: match.error_code });
        case 'failed':
        case 'network_error':
          return finish({ terminal: 'failed', errorCode: match.error_code });
      }
    };
    chrome.storage.onChanged.addListener(onChange);
  });
}

// Stage label shown on the pin button while processing
const STAGE_LABEL: Record<string, string> = {
  sending:      '⟳',
  queued:       '•',
  fetching:     '⟳ fetch',
  classifying:  '⟳ read',
  resolving:    '⟳ resolve',
};

// ── Create pin button ─────────────────────────────────────────────────────────

export function makePin(opts: PinOptions): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type       = 'button';
  btn.className  = `sonar-pin v-${opts.variant ?? 'default'}`;
  btn.title      = 'Pin to Radar';
  btn.textContent = '📡';
  btn.setAttribute('data-sonar', '1');
  btn.setAttribute('data-sonar-url', opts.capture.url);

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.classList.contains('sonar-busy')) return;
    if (btn.classList.contains('sonar-done')) return;

    btn.classList.add('sonar-busy');
    btn.textContent = '⟳';

    // Refresh captured_at and selected_text at click time
    const cap: SonarCapture = {
      ...opts.capture,
      captured_at:   new Date().toISOString(),
      selected_text: window.getSelection()?.toString().slice(0, 400) || undefined,
    };

    const ok = await dispatchCapture(cap).catch(() => false);

    btn.classList.remove('sonar-busy');
    if (!ok) {
      btn.textContent = '📡';
      toast('Failed to capture', false);
      return;
    }

    btn.classList.add('sonar-queued');
    btn.textContent = '•';
    btn.title       = 'Queued — processing in Radar…';
    toast('Captured · queuing…');

    const completion = await watchJob(
      opts.capture.url,
      (status) => {
        const label = STAGE_LABEL[status];
        if (label && btn.classList.contains('sonar-queued')) {
          btn.textContent = label;
          btn.title       = `${status.charAt(0).toUpperCase() + status.slice(1)}…`;
        }
      },
    );
    btn.classList.remove('sonar-queued');

    const { terminal, org, watchId, isRefresh } = completion;

    if (terminal === 'completed') {
      btn.classList.add('sonar-done');
      btn.textContent = '✓';
      const orgSuffix = org ? ` · ${org}` : isRefresh ? ' · refreshed' : '';
      btn.title = watchId
        ? `Saved to Radar${orgSuffix} — click to open`
        : `Saved to Radar${orgSuffix}`;
      // If we have a watch_id, make the button navigate on re-click
      if (watchId) {
        btn.addEventListener('click', async (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          const cfg = await chrome.storage.local.get('sonar_config') as { sonar_config?: { host?: string } };
          const host = cfg.sonar_config?.host ?? 'https://admin.amplifyit.io';
          chrome.tabs.create({ url: `${host}/admin/gtm?tab=radar` });
        }, { once: true });
      }
      toast(`Saved to Radar${orgSuffix}`);
    } else if (terminal === 'needs_review') {
      btn.classList.add('sonar-review');
      btn.textContent = '⚠';
      btn.title       = 'Saved — org not resolved, needs review';
      toast('Saved · needs review — check popup', true);
    } else if (terminal === 'auth_required') {
      btn.classList.add('sonar-auth');
      btn.textContent = '🔒';
      btn.title       = 'Sign in — open extension popup';
      toast('Sign in to admin first', false);
    } else {
      btn.textContent = '📡';
      btn.title       = 'Pin to Radar';
      toast(terminal === 'timeout' ? 'Still processing — check popup' : 'Capture failed', false);
    }
  });

  return btn;
}

// Re-export types needed by injectors
export type { Purpose, Priority };
