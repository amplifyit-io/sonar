/**
 * injectors/x.ts — X / Twitter tweet + profile injector.
 *
 * Anchor: `article[data-testid="tweet"]` — stable since pre-Musk era.
 * X's React tree renders every tweet under this node.
 *
 * Permalink: extracted from the <time> element's parent <a href="/user/status/ID">.
 * More reliable than parsing __reactProps$ or hunting [role="link"].
 *
 * Inject target: [data-testid="caret"] (⋯ menu) — most stable action-row anchor.
 * We insert our pin immediately before it.
 *
 * Profile pages: inject once in [data-testid="userActions"] (Follow/Message row).
 *
 * Known quirks:
 *   - X streams tweets in batches as you scroll; each mutation inserts a batch
 *   - Caret sometimes renders AFTER the tweet body — we allow multiple passes
 *   - Quoted tweets nest article elements — skip inner ones
 */

import type { PlatformAdapter, PostTarget, RaiderCapture } from './types';
import { alreadyInjected, markInjected } from './types';
import { makePin, cleanUrl, ensurePinStyles } from '../pin';

const TWEET_SEL   = 'article[data-testid="tweet"]';
const CARET_SEL   = '[data-testid="caret"]';
const TWEET_TEXT  = '[data-testid="tweetText"]';
const USER_ACT    = '[data-testid="userActions"]';

function extractTweetUrl(tweet: Element): string | null {
  const timeLink = tweet.querySelector<HTMLAnchorElement>('a time');
  const a = timeLink?.closest('a');
  if (a?.href) return cleanUrl(a.href);

  const status = tweet.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
  if (status?.href) return cleanUrl(status.href);

  return null;
}

function extractAuthorName(tweet: Element): string | undefined {
  // [data-testid="User-Name"] contains display name + handle spans
  const nameEl = tweet.querySelector('[data-testid="User-Name"]');
  return nameEl?.querySelector('span')?.textContent?.trim() || undefined;
}

function extractAuthorUrl(tweet: Element): string | undefined {
  const timeLink = tweet.querySelector<HTMLAnchorElement>('a time');
  const a = timeLink?.closest('a');
  if (!a) return undefined;
  try {
    const u = new URL(a.href, location.origin);
    // href is /user/status/ID — profile is /user
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 1) return `https://x.com/${parts[0]}`;
  } catch { /* ignore */ }
  return undefined;
}

function injectProfilePin(): void {
  if (!/^\/[^/]+\/?$/.test(location.pathname)) return;

  const actions = document.querySelector(USER_ACT);
  if (!actions || alreadyInjected(actions)) return;

  const capture: RaiderCapture = {
    url:             cleanUrl(location.href),
    platform:        'x',
    kind:            'profile',
    page_title:      document.title,
    author_hint:     document.querySelector('[data-testid="UserName"] span')?.textContent?.trim(),
    captured_at:     new Date().toISOString(),
  };

  const pin = makePin({ capture, variant: 'x' });
  actions.appendChild(pin);
  markInjected(actions);
}

export const xAdapter: PlatformAdapter = {
  name:     'x',
  platform: 'x',

  matches: (h) => h.endsWith('x.com') || h.endsWith('twitter.com'),

  findPosts(root: Document): PostTarget[] {
    const tweets = root.querySelectorAll<HTMLElement>(TWEET_SEL);
    return Array.from(tweets).filter(el => {
      const url = extractTweetUrl(el);
      return url && /\/status\/\d+/.test(url);
    }).map(element => ({ element }));
  },

  extractPost(element: HTMLElement): RaiderCapture {
    const url = extractTweetUrl(element) ?? cleanUrl(location.href);
    return {
      url,
      platform:        'x',
      kind:            'post',
      page_title:      document.title,
      visible_text:    element.querySelector<HTMLElement>(TWEET_TEXT)?.innerText?.slice(0, 1000),
      author_hint:     extractAuthorName(element),
      author_url_hint: extractAuthorUrl(element),
      captured_at:     new Date().toISOString(),
    };
  },

  mountButton(element: HTMLElement, button: HTMLElement): void {
    const caret = element.querySelector(CARET_SEL);
    if (!caret) return; // defer — caret renders after tweet body sometimes

    // Don't double-inject
    if (caret.parentElement?.querySelector(':scope > .raider-pin')) {
      markInjected(element);
      return;
    }

    caret.parentElement?.insertBefore(button, caret);
    markInjected(element);
  },

  extractPage(): RaiderCapture {
    const isStatus = /\/status\/\d+/.test(location.pathname);

    // On single-tweet pages, pull the primary article's text
    let visible_text: string | undefined;
    if (isStatus) {
      const primaryTweet = document.querySelector<HTMLElement>(
        `article[data-testid="tweet"] [data-testid="tweetText"]`,
      );
      const text = primaryTweet?.innerText?.trim();
      if (text) visible_text = text.slice(0, 1000);
    }

    return {
      url:          cleanUrl(location.href),
      platform:     'x',
      kind:         isStatus ? 'post' : 'profile',
      page_title:   document.title,
      visible_text,
      captured_at:  new Date().toISOString(),
    };
  },

  scan(): void {
    try { injectProfilePin(); } catch { /* ignore */ }

    const posts = this.findPosts(document);
    for (const post of posts) {
      if (alreadyInjected(post.element)) continue;
      try {
        const capture = this.extractPost(post.element);
        const btn     = makePin({ capture, variant: 'x' });
        this.mountButton(post.element, btn);
      } catch { /* per-post failures must not kill the scan */ }
    }
  },
};

// Legacy named export so content.ts can reference as before
export const xInjector = xAdapter;
