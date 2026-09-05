import { Feed } from 'feed';
import type { CandidateEvent } from '../types.js';

// Like ICS, RSS items may carry a review description (HTML with the triage
// links plus plain-text fallback URLs). Approved events keep the plain
// date-range description as before.
export type RssFeedEvent = CandidateEvent & {
  description?: string;
};

export function buildRss(events: RssFeedEvent[], feedBaseUrl: string): string {
  const feed = new Feed({
    title: 'dontforget',
    id: feedBaseUrl,
    link: feedBaseUrl,
    description: 'Approved recurring-event dates',
    copyright: '',
  });

  for (const event of events) {
    feed.addItem({
      title: `${event.label} — ${event.startDate}`,
      id: event.id,
      link: event.sourceUrl,
      description: event.description ?? `${event.startDate} to ${event.endDate}`,
      date: new Date(`${event.startDate}T00:00:00Z`),
    });
  }

  return feed.rss2();
}
