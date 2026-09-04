import { createEvents, type EventAttributes } from 'ics';
import type { CandidateEvent } from '../types.js';
import { CALENDAR_SLUG } from './feedUrl.js';

// Feed events may carry a review payload: plain-text DESCRIPTION plus an
// HTML variant (X-ALT-DESC via htmlContent) with the clickable triage links.
// Approved events omit both, as before.
export type IcsFeedEvent = CandidateEvent & {
  description?: string;
  htmlDescription?: string;
};

export function buildIcs(events: IcsFeedEvent[]): string {
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

function toIcsEvent(event: IcsFeedEvent): EventAttributes {
  const attrs: EventAttributes = {
    // Stable UID per event so calendar clients update the entry in place on
    // each poll instead of stacking duplicates (the library default is a
    // random nanoid per render). Review entries derive their id from the
    // candidate event id with a `review-` prefix, keeping them distinct from
    // the confirmed entry that appears after approval.
    uid: `${event.id}@dontforget`,
    title: event.label,
    start: toDateArray(event.startDate),
    end: toDateArray(addDays(event.endDate, 1)), // DTEND is exclusive for all-day events
    url: event.sourceUrl,
  };
  if (event.description !== undefined) {
    attrs.description = event.description;
  }
  if (event.htmlDescription !== undefined) {
    attrs.htmlContent = event.htmlDescription;
  }
  return attrs;
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
