/**
 * injectors/reddit.ts — Reddit injector (handles new + old UIs).
 *
 * Reddit has two active frontends:
 *   1. New Reddit (reddit.com)     — Web Components: <shreddit-post>
 *   2. Old Reddit (old.reddit.com) — server-rendered: div.thing[data-permalink]
 *
 * Both expose canonical post URLs as element attributes — no fragile selector
 * hunting required. Selectors used here are attribute-based, not class-based.
 */

import type { PlatformAdapter, PostTarget, RaiderCapture } from './types';
import { alreadyInjected, markInjected } from './types';
import { makePin, cleanUrl } from '../pin';

// ── New Reddit (web components) ──────────────────────────────────────────────

const SHREDDIT_SEL  = 'shreddit-post';
const OLD_POST_SEL  = 'div.thing[data-permalink]';

// ── Exported adapter ──────────────────────────────────────────────────────────

export const redditAdapter: PlatformAdapter = {
  name:     'reddit',
  platform: 'web', // Reddit treated as generic web for capture purposes

  matches: (h) => h.endsWith('reddit.com'),

  findPosts(root: Document): PostTarget[] {
    const shreddit = Array.from(root.querySelectorAll<HTMLElement>(SHREDDIT_SEL));
    const oldPosts = Array.from(root.querySelectorAll<HTMLElement>(OLD_POST_SEL));
    return [...shreddit, ...oldPosts].map(element => ({ element }));
  },

  extractPost(element: HTMLElement): RaiderCapture {
    let url: string;

    if (element.tagName.toLowerCase() === 'shreddit-post') {
      const permalink = element.getAttribute('permalink') ?? element.getAttribute('content-href') ?? '';
      url = permalink.startsWith('http')
        ? cleanUrl(permalink)
        : cleanUrl(`https://www.reddit.com${permalink}`);
    } else {
      // Old Reddit
      const permalink = element.getAttribute('data-permalink') ?? '';
      url = cleanUrl(`https://old.reddit.com${permalink}`);
    }

    const title =
      element.getAttribute('post-title') ??
      element.querySelector<HTMLElement>('a.title')?.innerText?.trim() ??
      document.title;

    return {
      url,
      platform:     'web',
      kind:         'post',
      page_title:   document.title,
      visible_text: title.slice(0, 500),
      captured_at:  new Date().toISOString(),
    };
  },

  mountButton(element: HTMLElement, button: HTMLElement): void {
    if (element.tagName.toLowerCase() === 'shreddit-post') {
      // New Reddit: inject into overflow-menu parent or credit-bar slot
      const actionRow =
        element.querySelector('shreddit-post-overflow-menu')?.parentElement ??
        element.querySelector('[slot="credit-bar"]') ??
        element.querySelector('[bundlename="post_credit_bar"]');

      if (!actionRow) return;
      if (actionRow.querySelector(':scope > .raider-pin')) { markInjected(element); return; }

      button.style.marginLeft = '4px';
      actionRow.appendChild(button);
    } else {
      // Old Reddit: inject as <li> into the .flat-list.buttons action row
      const actionRow = element.querySelector('ul.flat-list.buttons');
      if (!actionRow) return;
      if (actionRow.querySelector(':scope > .raider-pin, .raider-pin')) { markInjected(element); return; }

      const li = document.createElement('li');
      li.appendChild(button);
      actionRow.appendChild(li);
    }
    markInjected(element);
  },

  extractPage(): RaiderCapture {
    return {
      url:         cleanUrl(location.href),
      platform:    'web',
      kind:        location.pathname.includes('/comments/') ? 'post' : 'page',
      page_title:  document.title,
      captured_at: new Date().toISOString(),
    };
  },

  scan(): void {
    const posts = this.findPosts(document);
    for (const post of posts) {
      if (alreadyInjected(post.element)) continue;
      try {
        const capture  = this.extractPost(post.element);
        const isOld    = post.element.tagName === 'DIV';
        const btn      = makePin({ capture, variant: isOld ? 'reddit-old' : 'reddit' });
        if (isOld) btn.textContent = 'pin'; // plain text looks native in old.reddit
        this.mountButton(post.element, btn);
      } catch { /* per-post failures must not kill the scan */ }
    }
  },
};

// Legacy alias
export const redditInjector = redditAdapter;
