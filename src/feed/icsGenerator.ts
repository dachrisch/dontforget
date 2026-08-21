import { createEvents, type EventAttributes } from 'ics';
import type { CandidateEvent } from '../types.js';
import { CALENDAR_SLUG } from './feedUrl.js';

export function buildIcs(events: CandidateEvent[]): string {
  const { error, value } = createEvents(events.map(toIcsEvent), { calName: CALENDAR_SLUG });
  if (error || !value) {
    throw new Error(`failed to build ICS: ${error?.message ?? 'unknown error'}`);
  }
  // The `ics` library only emits the legacy X-WR-CALNAME property. We also
  // add the RFC 7986 NAME property as a more broadly recognized alternative
  // — but note neither is read by Google Calendar's "Add by URL" flow, which
  // always falls back to the feed URL for the calendar's display name. The
  // readable slug in that URL (see feedUrl.ts) exists to make that fallback
  // legible rather than a bare token hash.
  return value.replace(/^X-WR-CALNAME:.*\r?\n/m, match => `${match}NAME:${CALENDAR_SLUG}\r\n`);
}

function toIcsEvent(event: CandidateEvent): EventAttributes {
  return {
    title: event.label,
    start: toDateArray(event.startDate),
    end: toDateArray(addDays(event.endDate, 1)), // DTEND is exclusive for all-day events
    url: event.sourceUrl,
  };
}

function toDateArray(isoDate: string): [number, number, number] {
  const [y, m, d] = isoDate.split('-').map(Number);
  return [y, m, d];
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}