import { describe, it, expect } from 'vitest';
import { reducer, type WorkspaceState } from './state';
import type { EventDetail, QueryStatus } from './types';

function query(id: string, status: QueryStatus = 'ready'): import('./types').QuerySummary {
  return {
    id,
    text: 'Auer Dult Munich',
    recurrenceInterval: 'monthly',
    lastRunAt: null,
    createdAt: '2026-08-10T00:00:00Z',
    approvedCount: 0,
    candidateCount: 0,
    status,
  };
}

function dashboard(queries: import('./types').QuerySummary[]): WorkspaceState {
  return { kind: 'dashboard', queries, feed: null, editing: null, reviewing: null };
}

describe('reducer', () => {
  it('moves from signedOut to linkSent on MAGIC_LINK_SENT', () => {
    const next = reducer({ kind: 'signedOut' }, { type: 'MAGIC_LINK_SENT' });
    expect(next).toEqual({ kind: 'linkSent' });
  });

  it('loads the dashboard and starts with no query being edited or reviewed', () => {
    const next = reducer({ kind: 'signedOut' }, {
      type: 'DASHBOARD_LOADED',
      queries: [query('q1')],
      feed: { icsUrl: 'https://x/f/t.ics', rssUrl: 'https://x/f/t.rss', lastFetchedAt: null },
    });
    expect(next).toMatchObject({ kind: 'dashboard', editing: null, reviewing: null });
  });

  it('keeps an open review card across a dashboard refresh when its query still exists', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'yearly', events: [] },
    };
    const next = reducer(state, { type: 'DASHBOARD_LOADED', queries: [query('q1')], feed: null });
    expect(next).toMatchObject({ reviewing: { queryId: 'q1', recurrenceInterval: 'yearly', events: [] } });
  });

  it('drops an open review card when a dashboard refresh no longer lists its query', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'yearly', events: [] },
    };
    const next = reducer(state, { type: 'DASHBOARD_LOADED', queries: [], feed: null });
    expect(next).toMatchObject({ reviewing: null });
  });

  it('starts reviewing a query prefilled with its stored cadence', () => {
    const state = dashboard([query('q1')]);
    const next = reducer(state, { type: 'START_REVIEW', queryId: 'q1' });
    expect(next).toMatchObject({
      kind: 'dashboard',
      reviewing: { queryId: 'q1', recurrenceInterval: 'monthly', events: [] },
    });
  });

  it('ignores START_REVIEW when the query does not exist', () => {
    const state = dashboard([]);
    expect(reducer(state, { type: 'START_REVIEW', queryId: 'q1' })).toBe(state);
  });

  it('loads events into the open review card, leaving pending candidates unselected', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'weekly', events: [] },
    };
    const events: EventDetail[] = [
      { id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u', status: 'approved' },
      { id: 'e2', label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'u', status: 'candidate' },
    ];
    const next = reducer(state, { type: 'REVIEW_EVENTS_LOADED', queryId: 'q1', events });
    expect(next).toMatchObject({
      reviewing: {
        events: [
          { id: 'e1', status: 'approved', selected: false },
          { id: 'e2', status: 'candidate', selected: false },
        ],
      },
    });
  });

  it('ignores loaded review events when they do not match the query being reviewed', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'weekly', events: [] },
    };
    expect(reducer(state, { type: 'REVIEW_EVENTS_LOADED', queryId: 'q2', events: [] })).toBe(state);
  });

  it('toggles a pending candidate in the review card and leaves approved events alone', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      reviewing: {
        queryId: 'q1',
        recurrenceInterval: 'weekly',
        events: [
          { id: 'e1', label: 'A', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u', status: 'candidate', selected: true },
          { id: 'e2', label: 'B', startDate: '2026-01-02', endDate: '2026-01-02', sourceUrl: 'u', status: 'approved', selected: false },
        ],
      },
    };
    const next = reducer(state, { type: 'TOGGLE_REVIEW_EVENT', id: 'e1' });
    expect(next).toMatchObject({ reviewing: { events: [{ id: 'e1', selected: false }, { id: 'e2', selected: false }] } });
  });

  it('updates the review cadence the user picks before approving', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'yearly', events: [] },
    };
    const next = reducer(state, { type: 'SET_REVIEW_INTERVAL', interval: 'monthly' });
    expect(next).toMatchObject({ reviewing: { recurrenceInterval: 'monthly' } });
  });

  it('closes the review card on CANCEL_REVIEW', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'weekly', events: [] },
    };
    const next = reducer(state, { type: 'CANCEL_REVIEW' });
    expect(next).toMatchObject({ reviewing: null });
  });

  it('closes the review card on REVIEW_APPROVED', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'weekly', events: [] },
    };
    const next = reducer(state, { type: 'REVIEW_APPROVED', queryId: 'q1' });
    expect(next).toMatchObject({ reviewing: null });
  });

  it('ignores REVIEW_APPROVED when a different query is open', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1'), query('q2')],
      feed: null,
      editing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'weekly', events: [] },
    };
    expect(reducer(state, { type: 'REVIEW_APPROVED', queryId: 'q2' })).toBe(state);
  });

  it('starts editing a saved query prefilled with its own values', () => {
    const state = dashboard([query('q1')]);
    const next = reducer(state, { type: 'START_EDIT', queryId: 'q1' });
    expect(next).toMatchObject({
      kind: 'dashboard',
      editing: { queryId: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'monthly', events: [] },
    });
  });

  it('loads events into the open edit card, leaving pending candidates unselected', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: { queryId: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'monthly', events: [] },
      reviewing: null,
    };
    const events: EventDetail[] = [
      { id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u', status: 'approved' },
      { id: 'e2', label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'u', status: 'candidate' },
    ];
    const next = reducer(state, { type: 'EDIT_EVENTS_LOADED', queryId: 'q1', events });
    expect(next).toMatchObject({
      editing: {
        events: [
          { id: 'e1', status: 'approved', selected: false },
          { id: 'e2', status: 'candidate', selected: false },
        ],
      },
    });
  });

  it('ignores loaded edit events when they do not match the query being edited', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query('q1')],
      feed: null,
      editing: { queryId: 'q1', text: 'A', recurrenceInterval: 'monthly', events: [] },
      reviewing: null,
    };
    expect(reducer(state, { type: 'EDIT_EVENTS_LOADED', queryId: 'q2', events: [] })).toBe(state);
  });

  it('toggles a pending candidate inside the edit card and leaves approved events alone', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [],
      feed: null,
      editing: {
        queryId: 'q1',
        text: 'A',
        recurrenceInterval: 'monthly',
        events: [
          { id: 'e1', label: 'A', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u', status: 'candidate', selected: true },
          { id: 'e2', label: 'B', startDate: '2026-01-02', endDate: '2026-01-02', sourceUrl: 'u', status: 'approved', selected: false },
        ],
      },
      reviewing: null,
    };
    const next = reducer(state, { type: 'TOGGLE_EDIT_EVENT', id: 'e1' });
    expect(next).toMatchObject({ editing: { events: [{ id: 'e1', selected: false }, { id: 'e2', selected: false }] } });
  });

  it('cancels editing', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [],
      feed: null,
      editing: { queryId: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'monthly', events: [] },
      reviewing: null,
    };
    const next = reducer(state, { type: 'CANCEL_EDIT' });
    expect(next).toEqual({ kind: 'dashboard', queries: [], feed: null, editing: null, reviewing: null });
  });

  it('removes a deleted query from the dashboard', () => {
    const q1 = query('q1');
    const state = dashboard([q1, query('q2')]);
    const next = reducer(state, { type: 'QUERY_DELETED', queryId: 'q1' });
    expect(next).toMatchObject({ kind: 'dashboard', queries: [{ id: 'q2' }] });
  });

  it('clears an open edit when the query being deleted is the one being edited', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [],
      feed: null,
      editing: { queryId: 'q1', text: 'A', recurrenceInterval: 'monthly', events: [] },
      reviewing: null,
    };
    const next = reducer(state, { type: 'QUERY_DELETED', queryId: 'q1' });
    expect(next).toMatchObject({ kind: 'dashboard', editing: null });
  });

  it('clears an open review when the query being deleted is the one being reviewed', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [],
      feed: null,
      editing: null,
      reviewing: { queryId: 'q1', recurrenceInterval: 'weekly', events: [] },
    };
    const next = reducer(state, { type: 'QUERY_DELETED', queryId: 'q1' });
    expect(next).toMatchObject({ kind: 'dashboard', reviewing: null });
  });

  it('ignores events that do not apply to the current state', () => {
    const state: WorkspaceState = { kind: 'empty' };
    expect(reducer(state, { type: 'TOGGLE_REVIEW_EVENT', id: 'e1' })).toBe(state);
  });
});