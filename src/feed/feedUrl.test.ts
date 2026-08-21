import { describe, it, expect } from 'vitest';
import { buildFeedUrls } from './feedUrl';

describe('buildFeedUrls', () => {
  it('embeds a readable slug ahead of the extension', () => {
    const { icsUrl, rssUrl } = buildFeedUrls('https://dontforget.lehel.xyz', 'abc123');

    expect(icsUrl).toBe('https://dontforget.lehel.xyz/f/abc123/dontforget.ics');
    expect(rssUrl).toBe('https://dontforget.lehel.xyz/f/abc123/dontforget.rss');
  });
});
