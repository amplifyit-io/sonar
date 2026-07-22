/**
 * content.ts — Sonar content script (platform router).
 *
 * Responsibilities:
 *   1. Boot: pick adapter, log diagnostics
 *   2. Initial scan (3 deferred passes for React/SPA hydration)
 *   3. Continuous scan via debounced MutationObserver (addedNodes only)
 *   4. Re-scan on SPA navigation (NAVIGATE from background)
 *   5. Re-scan when LinkedIn inline toggle changes in settings
 *   6. Toast forwarding (SHOW_TOAST from background)
 *
 * Diagnostics:
 *   Open DevTools console on the page and look for:
 *     [Sonar] booted | platform=x | host=x.com
 *     [Sonar] scan | posts_found=12 | injected=12 | already_done=0
 *   If posts_found=0 on LinkedIn, the selectors need updating.
 */

import { ensurePinStyles, toast } from './pin';
import { linkedinAdapter, setInlineToggleCallback } from './injectors/linkedin';
import { xAdapter }        from './injectors/x';
import { redditAdapter }   from './injectors/reddit';
import { webAdapter }      from './injectors/web';
import type { PlatformAdapter, PostTarget } from './injectors/types';
import { alreadyInjected } from './injectors/types';

// ── Adapter registry — specific before generic ────────────────────────────────

const ADAPTERS: readonly PlatformAdapter[] = [
  linkedinAdapter,
  xAdapter,
  redditAdapter,
  webAdapter,   // always matches — must be last
];

const host   = location.hostname;
const active = ADAPTERS.find(a => a.matches(host)) ?? webAdapter;

console.info(`[Sonar] booted | platform=${active.name} | host=${host}`);

// ── Styles ────────────────────────────────────────────────────────────────────

try { ensurePinStyles(); } catch (e) { console.warn('[Sonar] ensurePinStyles failed', e); }

// ── Scan ──────────────────────────────────────────────────────────────────────

let scanTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleScan(reason = 'mutation'): void {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    runScan(reason);
  }, 300);
}

function runScan(reason: string): void {
  try {
    // Diagnostic: log what the adapter finds so broken selectors are obvious
    const posts: PostTarget[] = (() => {
      try { return active.findPosts(document); } catch { return []; }
    })();

    const newPosts  = posts.filter(p => !alreadyInjected(p.element));
    const donePosts = posts.length - newPosts.length;

    if (posts.length > 0 || reason === 'boot') {
      console.debug(
        `[Sonar] scan(${reason}) | platform=${active.name}` +
        ` | found=${posts.length} | new=${newPosts.length} | done=${donePosts}`,
      );
    }

    // scan() may be async (LinkedIn checks storage for inline flag)
    const result = active.scan();
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(e =>
        console.warn('[Sonar] scan async error', e),
      );
    }
  } catch (e) {
    console.warn(`[Sonar] scan(${reason}) error on ${active.name}:`, e);
  }
}

// ── Boot passes ───────────────────────────────────────────────────────────────
// React SPAs often hydrate in multiple waves — three passes covers them.

const BOOT_DELAYS = [400, 1200, 2500];
for (const ms of BOOT_DELAYS) {
  setTimeout(() => scheduleScan('boot'), ms);
}

// ── MutationObserver — addedNodes only ───────────────────────────────────────

const observer = new MutationObserver((mutations) => {
  if (mutations.some(m => m.addedNodes.length > 0)) scheduleScan('mutation');
});

observer.observe(document.documentElement, { childList: true, subtree: true });

// ── LinkedIn inline toggle: re-scan immediately when setting changes ───────────
// Without this, changing the toggle in popup has no effect until the user
// navigates or the feed updates.

if (active.name === 'linkedin') {
  setInlineToggleCallback(() => {
    console.info('[Sonar] LinkedIn inline toggle changed — rescanning');
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    runScan('inline_toggle');
  });
}

// ── Messages from background ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as { type: string; text?: string; ok?: boolean };

  if (m.type === 'NAVIGATE') {
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    for (const ms of BOOT_DELAYS) setTimeout(() => scheduleScan('navigate'), ms);
    return;
  }

  if (m.type === 'SHOW_TOAST') {
    try { toast(m.text ?? 'Pinned to Radar', m.ok !== false); }
    catch (e) { console.warn('[Sonar] toast failed', e); }
    return;
  }

  // Background requests page context before ingesting via keyboard shortcut or
  // context menu — gives it visible_text + author hints without DOM access.
  if (m.type === 'GET_CAPTURE_CONTEXT') {
    try {
      const capture = active.extractPage();
      sendResponse({
        visible_text:    capture.visible_text,
        author_hint:     capture.author_hint,
        author_url_hint: capture.author_url_hint,
        platform:        capture.platform,
        kind:            capture.kind,
      });
    } catch (e) {
      console.warn('[Sonar] GET_CAPTURE_CONTEXT error', e);
      sendResponse({});
    }
    return true; // keep channel open for async sendResponse
  }
});
