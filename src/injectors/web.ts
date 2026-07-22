/**
 * injectors/web.ts — Generic web / news / article fallback adapter.
 *
 * This adapter covers every site that doesn't have a dedicated adapter.
 * It provides:
 *   1. No per-post injection (pages are too varied to inject reliably)
 *   2. A reliable page-level capture via toolbar button, context menu, or keyboard shortcut
 *   3. Selected-text capture: if the user selects text before clicking, it's included
 *
 * This is the reliability fallback. 100% of pages can be captured this way.
 * The backend pipeline handles parsing and entity resolution.
 */

import type { PlatformAdapter, PostTarget, SonarCapture } from './types';
import { cleanUrl } from '../pin';

function guessKind(): SonarCapture['kind'] {
  // Article detection: look for <article> with substantial text, or article schema
  const article = document.querySelector('article');
  if (article && (article.innerText?.length ?? 0) > 200) return 'article';

  // Open Graph type hint
  const ogType = document.querySelector<HTMLMetaElement>('meta[property="og:type"]')?.content;
  if (ogType?.includes('article')) return 'article';

  return 'page';
}

function extractPageText(): string | undefined {
  // Prefer article body, fall back to first 500 chars of meta description
  const article = document.querySelector('article');
  if (article) return (article as HTMLElement).innerText?.slice(0, 500);

  const desc = document.querySelector<HTMLMetaElement>(
    'meta[name="description"], meta[property="og:description"]',
  )?.content;
  return desc?.slice(0, 500);
}

export const webAdapter: PlatformAdapter = {
  name:     'web',
  platform: 'web',

  // Generic adapter never matches before specific adapters — content.ts
  // routes to this one as the final fallback (matches returns true always).
  matches: () => true,

  findPosts(): PostTarget[] {
    // No per-post injection for generic web pages
    return [];
  },

  extractPost(): SonarCapture {
    // Unused — findPosts always returns []
    return this.extractPage();
  },

  mountButton(): void {
    // No per-post buttons on generic pages
  },

  extractPage(): SonarCapture {
    return {
      url:          cleanUrl(location.href),
      platform:     'web',
      kind:         guessKind(),
      page_title:   document.title,
      visible_text: extractPageText(),
      selected_text: window.getSelection()?.toString().slice(0, 400) || undefined,
      captured_at:  new Date().toISOString(),
    };
  },

  scan(): void {
    // Generic web adapter has nothing to inject into the page.
    // Capture happens via toolbar button / context menu / keyboard shortcut.
  },
};
