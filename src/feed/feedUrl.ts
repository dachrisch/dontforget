export const CALENDAR_SLUG = 'dontforget';

export function buildFeedUrls(publicBaseUrl: string, token: string): { icsUrl: string; rssUrl: string } {
  return {
    icsUrl: `${publicBaseUrl}/f/${token}/${CALENDAR_SLUG}.ics`,
    rssUrl: `${publicBaseUrl}/f/${token}/${CALENDAR_SLUG}.rss`,
  };
}
