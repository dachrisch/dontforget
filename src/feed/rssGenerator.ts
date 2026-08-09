import { Feed } from 'feed';
import type { CandidateEvent } from '../types.js';

export function buildRss(events: CandidateEvent[], feedBaseUrl: string): string {
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
      description: `${event.startDate} to ${event.endDate}`,
      date: new Date(`${event.startDate}T00:00:00Z`),
    });
  }

  return feed.rss2();
}