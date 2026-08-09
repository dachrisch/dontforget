import { describe, it, expect } from 'vitest';
import { buildIcs } from './icsGenerator';
import type { CandidateEvent } from '../types';

describe('buildIcs', () => {
  it('renders one VEVENT per approved event', () => {
    const events: CandidateEvent[] = [
      { id: '1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'https://auerdult.de', status: 'approved' },
      { id: '2', label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'https://muenchen.de', status: 'approved' },
    ];

    const ics = buildIcs(events);

    expect(ics).toContain('BEGIN:VCALENDAR');
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
    expect(ics).toContain('SUMMARY:Frühjahrsdult');
  });
});