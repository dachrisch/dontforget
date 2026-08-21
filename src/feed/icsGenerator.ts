import { createEvents, type EventAttributes } from 'ics';
import type { CandidateEvent } from '../types.js';

const CALENDAR_NAME = 'dontforget';

export function buildIcs(events: CandidateEvent[]): string {
  const { error, value } = createEvents(events.map(toIcsEvent), { calName: CALENDAR_NAME });
  if (error || !value) {
    throw new Error(`failed to build ICS: ${error?.message ?? 'unknown error'}`);
  }
  // The `ics` library only emits the legacy X-WR-CALNAME property. Some
  // subscribers (notably Google Calendar's "add by URL" flow) don't reliably
  // honor it, so we also add the RFC 7986 NAME property, which carries the
  // same meaning under the current iCalendar standard.
  return value.replace(/^X-WR-CALNAME:.*\r?\n/m, match => `${match}NAME:${CALENDAR_NAME}\r\n`);
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