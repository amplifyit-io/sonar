/**
 * injectors/types.ts — Platform adapter interface.
 *
 * Each platform injector must implement PlatformAdapter.
 * The content script picks ONE adapter per hostname and delegates
 * both scan-and-inject and per-page capture to it.
 *
 * Extension capture contract:
 *   The extension captures minimal observable context from the page.
 *   All intelligence (entity resolution, org/person binding, classification)
 *   happens in the backend pipeline. The extension MUST NOT attempt to
 *   produce final Radar objects.
 */

// ── Capture payload (sent to backend) ─────────────────────────────────────────

export type Platform = 'x' | 'linkedin' | 'reddit' | 'web';
export type CaptureKind = 'post' | 'profile' | 'article' | 'page';

export interface SonarCapture {
  url:              string;
  platform:         Platform;
  kind:             CaptureKind;
  page_title:       string;
  visible_text?:    string;       // first ~1000 chars of post body
  author_hint?:     string;       // display name from DOM
  author_url_hint?: string;       // profile URL if visible
  post_url_hint?:   string;       // permalink if different from url
  selected_text?:   string;       // browser selection at capture time
  captured_at:      string;       // ISO timestamp
}

// ── Adapter interface ─────────────────────────────────────────────────────────

export interface PostTarget {
  element: HTMLElement;
}

export interface PlatformAdapter {
  /** Human-readable name for logging */
  readonly name: string;
  /** Platform tag for the capture payload */
  readonly platform: Platform;
  /** True when this adapter owns the current hostname */
  matches(hostname: string): boolean;
  /**
   * Find injectable post containers in the current document.
   * MUST be idempotent — safe to call on every mutation.
   * MUST NOT throw — failures are caught by the router.
   */
  findPosts(root: Document): PostTarget[];
  /**
   * Extract a minimal capture payload from a post element.
   * MUST NOT perform network requests.
   * MUST NOT throw — failures are caught by the router.
   */
  extractPost(element: HTMLElement): SonarCapture;
  /**
   * Append/insert the pin button into the post's action row.
   * MUST be idempotent — guard with INJECTED_ATTR.
   * MUST NOT throw.
   */
  mountButton(element: HTMLElement, button: HTMLElement): void;
  /**
   * Extract a capture for the current full page (toolbar/keyboard capture).
   * Used when no per-post context is needed.
   */
  extractPage(): SonarCapture;
}

// ── Idempotency helpers ───────────────────────────────────────────────────────

/** Attribute stamped on each container we have already injected into */
export const INJECTED_ATTR = 'data-sonar-injected';

export function alreadyInjected(el: Element): boolean {
  return el.hasAttribute(INJECTED_ATTR);
}

export function markInjected(el: Element): void {
  el.setAttribute(INJECTED_ATTR, '1');
}

// ── Dedupe helper (used by reddit adapter) ────────────────────────────────────

export function dedupeElements(els: Array<Element | null | undefined>): HTMLElement[] {
  const seen = new Set<Element>();
  const out: HTMLElement[] = [];
  for (const el of els) {
    if (!el || seen.has(el)) continue;
    seen.add(el);
    out.push(el as HTMLElement);
  }
  return out;
}
