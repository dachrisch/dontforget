import { describe, it, expect } from 'vitest';
import { buildRss } from './rssGenerator';
import type { CandidateEvent } from '../types';

describe('buildRss', () => {
  it('renders one item per approved event', () => {
    const events: CandidateEvent[] = [
      { id: '1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de', status: 'approved' },
    ];

    const rss = buildRss(events, 'https://dontforget.lehel.xyz/f/abc');

    expect(rss).toContain('<rss');
    expect((rss.match(/<item>/g) ?? []).length).toBe(1);
    expect(rss).toContain('Frühjahrsdult');
  });
});