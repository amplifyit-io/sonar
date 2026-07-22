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
 * Default behaviour (SONAR_LI_INLINE = false):
 *   • One floating page-level pin button injected at the top of any page
 *   • Captures the URL of the current page with visible context
 *   • Toolbar button and context menu always work as fallback
 *
 * Feature-flagged behaviour (SONAR_LI_INLINE = true):
 *   • Per-post pin buttons injected onto each post card
 *   • Primary: next to the ⋯ control menu (action row)
 *   • Fallback: absolute overlay on the card itself (when action row not yet rendered)
 *   • Re-injection: React can wipe buttons on re-render; we detect and recover
 *
 * Selector strategy:
 *   LinkedIn changes class names frequently. We use:
 *     1. data-urn / data-id attributes (stable since 2018) — primary
 *     2. Semantic stable class names as secondary
 *     3. aria-label patterns for action buttons — most resilient to obfuscation
 *     4. We do NOT rely on obfuscated class names like artdeco-*
 */

import type { PlatformAdapter, PostTarget, SonarCapture } from './types';
import { INJECTED_ATTR, alreadyInjected, markInjected } from './types';
import { makePin, cleanUrl, ensurePinStyles } from '../pin';

// ── Feature flag ──────────────────────────────────────────────────────────────

let _inlineEnabled: boolean | null = null;
let _onInlineToggled: (() => void) | null = null;

export function setInlineToggleCallback(cb: () => void): void {
  _onInlineToggled = cb;
}

async function isInlineEnabled(): Promise<boolean> {
  if (_inlineEnabled !== null) return _inlineEnabled;
  const r = await chrome.storage.local.get('sonar_li_inline') as { sonar_li_inline?: boolean };
  _inlineEnabled = r.sonar_li_inline === true;
  return _inlineEnabled;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || changes.sonar_li_inline == null) return;
  _inlineEnabled = changes.sonar_li_inline.newValue === true;
  _onInlineToggled?.();
});

// ── Selectors ─────────────────────────────────────────────────────────────────

// Post containers — data-urn attributes stable since 2018 (primary).
// Semantic class names as secondary (LinkedIn rotates obfuscated ones).
const URN_POST_SEL = [
  '[data-urn*="urn:li:activity:"]',
  '[data-urn*="urn:li:share:"]',
  '[data-urn*="urn:li:ugcPost:"]',
  '[data-id*="urn:li:activity:"]',
  '[data-id*="urn:li:share:"]',
  '.feed-shared-update-v2',
  '.occludable-update',
].join(',');

// Control menu (⋯) — aria-label is the most resilient selector here.
const CONTROL_MENU_SELS = [
  'button[aria-label^="Open control menu"]',
  'button[aria-label^="More"]',
  'button[aria-label*="control menu"]',
  'button[aria-label*="Options for this"]',
  '.feed-shared-control-menu',
  '[class*="feed-shared-control-menu"]',
  '.update-components-header__menu-dropdown-trigger',
];

// Profile top-card containers — multiple variants (personal, premium, recruiter, company).
const PROFILE_HEADER_SELS = [
  '.pv-top-card',
  '.profile-top-card',
  '.org-top-card',
  '[data-view-name="profile-card"]',
  '[data-view-name="profile-top-card"]',
  'section.artdeco-card:first-of-type',   // last-resort structural selector
];

// Action button rows inside the profile header.
const PROFILE_ACTIONS_SELS = [
  '.pv-top-card__action-buttons',
  '.pv-top-card-v2__action-buttons',
  '.org-top-card-primary-actions__inner',
  '[class*="action-buttons"]',
  '[class*="pvs-header__actions"]',
  '.profile-header-actions',
  '.pv-top-card--list',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function findFirst<T extends Element>(root: Element | Document, sels: string[]): T | null {
  for (const sel of sels) {
    const el = root.querySelector<T>(sel);
    if (el) return el;
  }
  return null;
}

/** True if our pin button is still physically inside this element. */
function pinStillPresent(el: Element): boolean {
  return el.querySelector('.sonar-pin') !== null;
}

/**
 * Clear the injected marker so the element is eligible for re-injection.
 * Call this when React has wiped our button from a previously-marked element.
 */
function clearInjected(el: Element): void {
  el.removeAttribute(INJECTED_ATTR);
}

function extractUrnUrl(postEl: Element): string | null {
  const raw = postEl.getAttribute('data-urn') ?? postEl.getAttribute('data-id');
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
    '.feed-shared-inline-show-more-text',   // longer posts behind "see more"
  ];
  for (const sel of SELS) {
    const text = (postEl.querySelector(sel) as HTMLElement | null)?.innerText?.trim();
    if (text) return text.slice(0, 1000);
  }
  return '';
}

// ── Inline button mounting strategies ────────────────────────────────────────

/**
 * Strategy A: insert before the ⋯ control menu (preferred — matches LinkedIn's action row).
 * Returns true on success.
 */
function mountNextToControlMenu(post: HTMLElement, pin: HTMLElement): boolean {
  const anchor = findFirst(post, CONTROL_MENU_SELS);
  if (!anchor?.parentElement) return false;
  // Don't double-inject into the same row
  if (anchor.parentElement.querySelector(':scope > .sonar-pin')) return true;
  pin.style.marginRight = '4px';
  anchor.parentElement.insertBefore(pin, anchor);
  return true;
}

/**
 * Strategy B: absolute overlay on the post card.
 * Used when the action row hasn't rendered yet — avoids deferring injection
 * indefinitely on posts whose control menu never appears (ads, suggested posts).
 */
function mountAsOverlay(post: HTMLElement, pin: HTMLElement): void {
  // LinkedIn post cards are flex containers; we need relative positioning for abs child.
  const pos = window.getComputedStyle(post).position;
  if (pos === 'static') post.style.position = 'relative';

  Object.assign(pin.style, {
    position: 'absolute',
    top:      '10px',
    right:    '10px',
    zIndex:   '1',
  });
  post.appendChild(pin);
}

// ── Page-level floating pin (always injected, compliance-safe) ────────────────

const PAGE_PIN_ID = 'sonar-li-page-pin';

function ensurePagePin(): void {
  // If the element exists AND is still in the DOM → nothing to do.
  const existing = document.getElementById(PAGE_PIN_ID);
  if (existing && document.body?.contains(existing)) return;

  const capture = linkedinAdapter.extractPage();
  const btn     = makePin({ capture });
  btn.id        = PAGE_PIN_ID;

  Object.assign(btn.style, {
    position: 'fixed',
    top:      '64px',
    right:    '12px',
    zIndex:   '2147483646',
    opacity:  '0.4',
  });

  btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.9'; });
  btn.addEventListener('mouseleave', () => {
    if (!btn.classList.contains('sonar-done') && !btn.classList.contains('sonar-queued')) {
      btn.style.opacity = '0.4';
    }
  });

  document.body?.appendChild(btn);
}

// ── Profile-page pin (always injected, compliance-safe) ───────────────────────

function injectProfileHeader(): void {
  if (!/linkedin\.com\/(in|company)\//.test(location.href)) return;

  const header = findFirst(document, PROFILE_HEADER_SELS);
  if (!header) return;

  // Re-injection check: header was marked but React re-rendered and wiped the button.
  if (alreadyInjected(header) && pinStillPresent(header)) return;
  if (alreadyInjected(header) && !pinStillPresent(header)) clearInjected(header);

  const actions = findFirst(header, PROFILE_ACTIONS_SELS);
  if (!actions) return;

  const isCompany = /\/company\//.test(location.pathname);
  const capture: SonarCapture = {
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

// ── Per-post inline injection (SONAR_LI_INLINE only) ─────────────────────────

function injectInlineButtons(): void {
  const posts = document.querySelectorAll<HTMLElement>(URN_POST_SEL);

  for (const post of posts) {
    // React re-render recovery: button was wiped → clear marker, re-inject below.
    if (alreadyInjected(post)) {
      if (pinStillPresent(post)) continue;   // all good
      clearInjected(post);                    // wipe detected — fall through to re-inject
    }

    const url = extractUrnUrl(post);
    // Skip profile cards masquerading as feed posts (URN contains /in/ path)
    if (!url || /\/in\//.test(url)) { markInjected(post); continue; }
    // Minimum text guard — empty shells, ad wrappers, suggested-follows cards
    if ((post.innerText?.length ?? 0) < 30) { markInjected(post); continue; }

    const capture: SonarCapture = {
      url,
      platform:     'linkedin',
      kind:         'post',
      page_title:   document.title,
      visible_text: extractPostText(post),
      captured_at:  new Date().toISOString(),
    };

    const pin = makePin({ capture });

    // Strategy A: preferred — beside the ⋯ menu in the action row.
    // Strategy B: fallback — absolute overlay when action row not yet rendered.
    if (!mountNextToControlMenu(post, pin)) {
      mountAsOverlay(post, pin);
    }

    markInjected(post);
  }
}

// ── Exported adapter ──────────────────────────────────────────────────────────

export const linkedinAdapter: PlatformAdapter = {
  name:     'linkedin',
  platform: 'linkedin',

  matches: (h) => h.endsWith('linkedin.com'),

  findPosts(root: Document): PostTarget[] {
    return Array.from(root.querySelectorAll<HTMLElement>(URN_POST_SEL))
      .filter(el => {
        const url = extractUrnUrl(el);
        return (el.innerText?.length ?? 0) > 30 && (!url || !/\/in\//.test(url));
      })
      .map(element => ({ element }));
  },

  extractPost(element: HTMLElement): SonarCapture {
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
    if (!mountNextToControlMenu(element, button)) {
      mountAsOverlay(element, button);
    }
    markInjected(element);
  },

  extractPage(): SonarCapture {
    const isPost    = /\/feed\/update\//.test(location.pathname);
    const isCompany = /\/company\//.test(location.pathname);
    const isProfile = /\/in\//.test(location.pathname);
    const kind: SonarCapture['kind'] = isPost ? 'post' : isCompany ? 'page' : isProfile ? 'profile' : 'page';

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
    try { injectProfileHeader(); } catch { /* ignore */ }
    try { ensurePagePin(); }        catch { /* ignore */ }

    try {
      if (await isInlineEnabled()) {
        injectInlineButtons();
      }
    } catch { /* ignore */ }
  },
};

export const linkedinInjector = linkedinAdapter;
