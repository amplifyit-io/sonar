/**
 * injectors/linkedin.ts — LinkedIn injector.
 *
 * ⚠️ LinkedIn compliance constraint:
 *   LinkedIn explicitly prohibits third-party extensions that scrape, modify
 *   appearance, or automate activity on LinkedIn. See:
 *   https://www.linkedin.com/help/linkedin/answer/a1341387
 *
 *   Design rules enforced here:
 *     ✓ User-initiated capture only — the user explicitly clicks a pin button
 *     ✓ No auto-scraping / background scanning
 *     ✓ No automation (no liking, commenting, DMs, auto-scroll)
 *     ✓ No bulk extraction
 *     ✗ Inline per-post pin buttons are feature-flagged OFF by default
 *       (they are the highest-risk surface; use toolbar/context menu instead)
 *
 * Default behaviour (RAIDER_LI_INLINE = false):
 *   • One floating page-level pin button injected at the top of profile/post pages
 *   • Captures the URL of the current page with visible context
 *   • Toolbar button and context menu always work as fallback
 *
 * Feature-flagged behaviour (RAIDER_LI_INLINE = true):
 *   • Per-post pin buttons injected next to the ⋯ control menu
 *   • Only activates if the user explicitly enables this in the popup Config tab
 *   • Still user-initiated — no auto-capture, no auto-scroll
 *
 * Selector strategy:
 *   LinkedIn changes class names frequently. We use:
 *     1. data-urn attributes (stable since 2018)
 *     2. Semantic role/aria patterns as fallbacks
 *     3. We do NOT rely on obfuscated class names
 */

import type { PlatformAdapter, PostTarget, RaiderCapture } from './types';
import { alreadyInjected, markInjected } from './types';
import { makePin, cleanUrl, ensurePinStyles } from '../pin';

// ── Feature flag ──────────────────────────────────────────────────────────────
// Read once per page load from chrome.storage.local.
// Default: false (page-level capture only, compliant mode).

let _inlineEnabled: boolean | null = null;
// Callback registered by content.ts so a settings change triggers a re-scan
let _onInlineToggled: (() => void) | null = null;

export function setInlineToggleCallback(cb: () => void): void {
  _onInlineToggled = cb;
}

async function isInlineEnabled(): Promise<boolean> {
  if (_inlineEnabled !== null) return _inlineEnabled;
  const r = await chrome.storage.local.get('raider_li_inline') as { raider_li_inline?: boolean };
  _inlineEnabled = r.raider_li_inline === true;
  return _inlineEnabled;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || changes.raider_li_inline == null) return;
  _inlineEnabled = changes.raider_li_inline.newValue === true;
  // Notify content.ts so it fires a fresh scan immediately
  _onInlineToggled?.();
});

// ── Page-level pin (always injected, compliance-safe) ─────────────────────────

const PAGE_PIN_ID = 'raider-li-page-pin';

function ensurePagePin(): void {
  if (document.getElementById(PAGE_PIN_ID)) return;

  const capture = linkedinAdapter.extractPage();
  const btn     = makePin({ capture });
  btn.id        = PAGE_PIN_ID;

  // Style: small floating button top-right, does not overlap feed content
  Object.assign(btn.style, {
    position: 'fixed',
    top:      '64px',
    right:    '12px',
    zIndex:   '2147483646',
    opacity:  '0.4',
  });

  // On hover: more visible
  btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.9'; });
  btn.addEventListener('mouseleave', () => {
    if (!btn.classList.contains('raider-done') && !btn.classList.contains('raider-queued')) {
      btn.style.opacity = '0.4';
    }
  });

  document.body?.appendChild(btn);
}

// ── Per-post inline injection (RAIDER_LI_INLINE only) ─────────────────────────

// Priority order: most specific → least specific.
// LinkedIn changes class names regularly; we rely on data attributes first.
const URN_POST_SEL = [
  '[data-urn*="urn:li:activity:"]',
  '[data-urn*="urn:li:share:"]',
  '[data-urn*="urn:li:ugcPost:"]',
  '[data-id*="urn:li:activity:"]',      // alternate attribute seen on some feeds
  '[data-id*="urn:li:share:"]',
  '.feed-shared-update-v2',             // stable class for feed cards
  '.occludable-update',                 // used in some feed layouts
].join(',');

const CONTROL_MENU_SELS = [
  '.feed-shared-control-menu',
  '[class*="feed-shared-control-menu"]',
  '.update-components-header__menu-dropdown-trigger',
  'button[aria-label^="Open control menu"]',
  'button[aria-label^="More"]',
  'button[aria-label*="control menu"]',
  'button[aria-label*="Options for this"]',
];

function findControlAnchor(post: Element): Element | null {
  for (const sel of CONTROL_MENU_SELS) {
    const el = post.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function extractUrnUrl(postEl: Element): string | null {
  const raw = postEl.getAttribute('data-urn');
  if (!raw) return null;
  const m = raw.match(/(urn:li:(?:activity|share|ugcPost):\d+)/);
  if (!m) return null;
  return `https://www.linkedin.com/feed/update/${m[1]}/`;
}

function extractPostText(postEl: Element): string {
  const SELS = [
    '.update-components-text .break-words',
    '.feed-shared-update-v2__description-wrapper .break-words',
    '.feed-shared-text .break-words',
    '[data-test-id="main-feed-activity-card__commentary"]',
    'span.break-words',
  ];
  for (const sel of SELS) {
    const text = (postEl.querySelector(sel) as HTMLElement | null)?.innerText?.trim();
    if (text) return text.slice(0, 1000);
  }
  return '';
}

function injectInlineButtons(): void {
  const posts = document.querySelectorAll<HTMLElement>(URN_POST_SEL);

  for (const post of posts) {
    if (alreadyInjected(post)) continue;

    const url = extractUrnUrl(post);
    if (!url || /\/in\//.test(url)) { markInjected(post); continue; }

    const anchor = findControlAnchor(post);
    if (!anchor) continue; // defer — control menu may not have rendered yet

    if (anchor.parentElement?.querySelector(':scope > .raider-pin')) {
      markInjected(post); continue;
    }

    const capture: RaiderCapture = {
      url,
      platform:     'linkedin',
      kind:         'post',
      page_title:   document.title,
      visible_text: extractPostText(post),
      captured_at:  new Date().toISOString(),
    };

    const pin = makePin({ capture });
    pin.style.marginRight = '4px';
    anchor.parentElement?.insertBefore(pin, anchor);
    markInjected(post);
  }
}

// ── Profile-page pin (always injected, compliance-safe) ───────────────────────

function injectProfileHeader(): void {
  if (!/linkedin\.com\/(in|company)\//.test(location.href)) return;

  const header =
    document.querySelector('.pv-top-card') ??
    document.querySelector('.profile-top-card') ??
    document.querySelector('.org-top-card');
  if (!header || alreadyInjected(header)) return;

  const actions =
    header.querySelector('.pv-top-card__action-buttons') ??
    header.querySelector('.org-top-card-primary-actions__inner') ??
    header.querySelector('[class*="action-buttons"]');
  if (!actions) return;

  const isCompany = /\/company\//.test(location.pathname);
  const capture: RaiderCapture = {
    url:         cleanUrl(location.href),
    platform:    'linkedin',
    kind:        isCompany ? 'page' : 'profile',
    page_title:  document.title,
    captured_at: new Date().toISOString(),
  };

  const pin = makePin({ capture });
  pin.style.marginLeft = '6px';
  actions.appendChild(pin);
  markInjected(header);
}

// ── Exported adapter ──────────────────────────────────────────────────────────

export const linkedinAdapter: PlatformAdapter = {
  name:     'linkedin',
  platform: 'linkedin',

  matches: (h) => h.endsWith('linkedin.com'),

  findPosts(root: Document): PostTarget[] {
    // Filter: must have visible text (> 30 chars) to be a real post card,
    // not an empty shell or ad wrapper.
    return Array.from(root.querySelectorAll<HTMLElement>(URN_POST_SEL))
      .filter(el => {
        const url = extractUrnUrl(el);
        const hasEnoughText = (el.innerText?.length ?? 0) > 30;
        return hasEnoughText && (!url || !/\/in\//.test(url));
      })
      .map(element => ({ element }));
  },

  extractPost(element: HTMLElement): RaiderCapture {
    return {
      url:          extractUrnUrl(element) ?? cleanUrl(location.href),
      platform:     'linkedin',
      kind:         'post',
      page_title:   document.title,
      visible_text: extractPostText(element),
      captured_at:  new Date().toISOString(),
    };
  },

  mountButton(element: HTMLElement, button: HTMLElement): void {
    const anchor = findControlAnchor(element);
    if (!anchor) return;
    if (!anchor.parentElement?.querySelector(':scope > .raider-pin')) {
      button.style.marginRight = '4px';
      anchor.parentElement?.insertBefore(button, anchor);
    }
    markInjected(element);
  },

  extractPage(): RaiderCapture {
    const isPost    = /\/feed\/update\//.test(location.pathname);
    const isCompany = /\/company\//.test(location.pathname);
    const isProfile = /\/in\//.test(location.pathname);
    const kind: RaiderCapture['kind'] = isPost ? 'post' : isCompany ? 'page' : isProfile ? 'profile' : 'page';

    // On post detail pages, pull visible text so keyboard shortcut has real content
    let visible_text: string | undefined;
    if (isPost) {
      visible_text = extractPostText(document.documentElement) || undefined;
    }

    return {
      url:          cleanUrl(location.href),
      platform:     'linkedin',
      kind,
      page_title:   document.title,
      visible_text,
      captured_at:  new Date().toISOString(),
    };
  },

  async scan(): Promise<void> {
    // Always: profile-header pin and floating page-level pin
    try { injectProfileHeader(); } catch { /* ignore */ }
    try { ensurePagePin(); }        catch { /* ignore */ }

    // Inline per-post pins: only when explicitly enabled by operator
    try {
      if (await isInlineEnabled()) {
        injectInlineButtons();
      }
    } catch { /* ignore */ }
  },
};

// Legacy alias
export const linkedinInjector = linkedinAdapter;
