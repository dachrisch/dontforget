import { describe, it, expect } from 'vitest';
import { reducer, type WorkspaceState } from './state';
import type { EventDetail, QuerySummary } from './types';

describe('reducer', () => {
  it('moves from signedOut to linkSent on MAGIC_LINK_SENT', () => {
    const state: WorkspaceState = { kind: 'signedOut' };
    const next = reducer(state, { type: 'MAGIC_LINK_SENT' });
    expect(next).toEqual({ kind: 'linkSent' });
  });

  it('moves from empty to loading on SUBMIT_QUERY', () => {
    const state: WorkspaceState = { kind: 'empty' };
    const next = reducer(state, { type: 'SUBMIT_QUERY', text: 'Auer Dult Munich' });
    expect(next).toEqual({ kind: 'loading', queryText: 'Auer Dult Munich' });
  });

  it('moves from loading to review with all candidates pre-selected and the AI-suggested cadence', () => {
    const state: WorkspaceState = { kind: 'loading', queryText: 'Auer Dult Munich' };
    const next = reducer(state, {
      type: 'QUERY_RESOLVED',
      queryId: 'q1',
      suggestedInterval: 'yearly',
      candidates: [
        { id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u', status: 'candidate' },
      ],
    });
    expect(next).toEqual({
      kind: 'review',
      queryId: 'q1',
      candidates: [
        { id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u', status: 'candidate', selected: true },
      ],
      selectedInterval: 'yearly',
      suggestedInterval: 'yearly',
    });
  });

  it('falls back to the default cadence when the AI gives no suggestion', () => {
    const state: WorkspaceState = { kind: 'loading', queryText: 'Auer Dult Munich' };
    const next = reducer(state, {
      type: 'QUERY_RESOLVED',
      queryId: 'q1',
      suggestedInterval: null,
      candidates: [],
    });
    expect(next).toMatchObject({ kind: 'review', selectedInterval: 'weekly', suggestedInterval: null });
  });

  it('updates the review cadence the user picks before approving', () => {
    const state: WorkspaceState = {
      kind: 'review',
      queryId: 'q1',
      candidates: [],
      selectedInterval: 'yearly',
      suggestedInterval: 'yearly',
    };
    const next = reducer(state, { type: 'SET_REVIEW_INTERVAL', interval: 'monthly' });
    expect(next).toMatchObject({ kind: 'review', selectedInterval: 'monthly' });
  });

  it('toggles one candidate without touching the others', () => {
    const state: WorkspaceState = {
      kind: 'review',
      queryId: 'q1',
      candidates: [
        { id: 'e1', label: 'A', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u', status: 'candidate', selected: true },
        { id: 'e2', label: 'B', startDate: '2026-01-02', endDate: '2026-01-02', sourceUrl: 'u', status: 'candidate', selected: true },
      ],
      selectedInterval: 'yearly',
      suggestedInterval: 'yearly',
    };
    const next = reducer(state, { type: 'TOGGLE_CANDIDATE', id: 'e2' });
    expect(next).toEqual({
      ...state,
      candidates: [state.candidates[0], { ...state.candidates[1], selected: false }],
    });
  });

  it('moves from review to feedReady using the approved list from the event, not live state', () => {
    const state: WorkspaceState = {
      kind: 'review',
      queryId: 'q1',
      candidates: [
        { id: 'e1', label: 'A', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u', status: 'candidate', selected: true },
        // Selection changed after the approve request was already sent —
        // the event's own `approved` snapshot must win, not this state.
        { id: 'e2', label: 'B', startDate: '2026-01-02', endDate: '2026-01-02', sourceUrl: 'u', status: 'candidate', selected: true },
      ],
      selectedInterval: 'yearly',
      suggestedInterval: 'yearly',
    };
    const next = reducer(state, {
      type: 'APPROVE_RESOLVED',
      icsUrl: 'https://x/f/t.ics',
      rssUrl: 'https://x/f/t.rss',
      approved: [{ ...state.candidates[0], selected: true }],
    });
    expect(next).toEqual({
      kind: 'feedReady',
      icsUrl: 'https://x/f/t.ics',
      rssUrl: 'https://x/f/t.rss',
      approved: [state.candidates[0]],
    });
  });

  it('moves from loading back to empty on QUERY_FAILED, preserving the query text for retry', () => {
    const state: WorkspaceState = { kind: 'loading', queryText: 'Auer Dult Munich' };
    const next = reducer(state, { type: 'QUERY_FAILED' });
    expect(next).toEqual({ kind: 'empty', queryText: 'Auer Dult Munich' });
  });

  it('loads the dashboard and starts with no query being edited', () => {
    const next = reducer({ kind: 'signedOut' }, {
      type: 'DASHBOARD_LOADED',
      queries: [{ id: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'monthly', lastRunAt: null, createdAt: '2026-08-10T00:00:00Z', approvedCount: 2, candidateCount: 0 }],
      feed: { icsUrl: 'https://x/f/t.ics', rssUrl: 'https://x/f/t.rss', lastFetchedAt: null },
    });
    expect(next).toMatchObject({ kind: 'dashboard', editing: null });
  });

  it('starts editing a saved query prefilled with its own values', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [{ id: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'quarterly', lastRunAt: null, createdAt: '2026-08-10T00:00:00Z', approvedCount: 0, candidateCount: 0 }],
      feed: null,
      editing: null,
    };
    const next = reducer(state, { type: 'START_EDIT', queryId: 'q1' });
    expect(next).toMatchObject({
      kind: 'dashboard',
      editing: { queryId: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'quarterly', events: [] },
    });
  });

  it('loads events into the open edit card, pre-selecting pending candidates', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [{ id: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'monthly', lastRunAt: null, createdAt: '2026-08-10T00:00:00Z', approvedCount: 1, candidateCount: 1 }],
      feed: null,
      editing: { queryId: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'monthly', events: [] },
    };
    const events: EventDetail[] = [
      { id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u', status: 'approved' },
      { id: 'e2', label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'u', status: 'candidate' },
    ];
    const next = reducer(state, { type: 'EDIT_EVENTS_LOADED', queryId: 'q1', events });
    expect(next).toMatchObject({
      kind: 'dashboard',
      editing: {
        events: [
          { id: 'e1', status: 'approved', selected: false },
          { id: 'e2', status: 'candidate', selected: true },
        ],
      },
    });
  });

  it('ignores loaded events when they do not match the query being edited', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [],
      feed: null,
      editing: { queryId: 'q1', text: 'A', recurrenceInterval: 'monthly', events: [] },
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
    };
    const next = reducer(state, { type: 'CANCEL_EDIT' });
    expect(next).toEqual({ kind: 'dashboard', queries: [], feed: null, editing: null });
  });

  it('removes a deleted query from the dashboard', () => {
    const query: QuerySummary = { id: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'monthly', lastRunAt: null, createdAt: '2026-08-10T00:00:00Z', approvedCount: 0, candidateCount: 0 };
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [query, { ...query, id: 'q2' }],
      feed: null,
      editing: null,
    };
    const next = reducer(state, { type: 'QUERY_DELETED', queryId: 'q1' });
    expect(next).toMatchObject({ kind: 'dashboard', queries: [{ id: 'q2' }] });
  });

  it('clears an open edit when the query being deleted is the one being edited', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [],
      feed: null,
      editing: { queryId: 'q1', text: 'A', recurrenceInterval: 'monthly', events: [] },
    };
    const next = reducer(state, { type: 'QUERY_DELETED', queryId: 'q1' });
    expect(next).toMatchObject({ kind: 'dashboard', editing: null });
  });

  it('moves from the dashboard to loading on SUBMIT_QUERY, remembering the return path', () => {
    const state: WorkspaceState = { kind: 'dashboard', queries: [], feed: null, editing: null };
    const next = reducer(state, { type: 'SUBMIT_QUERY', text: 'Oktoberfest' });
    expect(next).toEqual({ kind: 'loading', queryText: 'Oktoberfest', fromDashboard: true });
  });

  it('carries the dashboard return path through to review', () => {
    const state: WorkspaceState = { kind: 'loading', queryText: 'Oktoberfest', fromDashboard: true };
    const next = reducer(state, {
      type: 'QUERY_RESOLVED',
      queryId: 'q1',
      suggestedInterval: 'yearly',
      candidates: [{ id: 'e1', label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-10-04', sourceUrl: 'u', status: 'candidate' }],
    });
    expect(next).toMatchObject({ kind: 'review', fromDashboard: true });
  });

  it('does not tag review with a return path for first-time searches', () => {
    const state: WorkspaceState = { kind: 'loading', queryText: 'Oktoberfest' };
    const next = reducer(state, {
      type: 'QUERY_RESOLVED',
      queryId: 'q1',
      suggestedInterval: null,
      candidates: [],
    });
    expect(next).toEqual({
      kind: 'review',
      queryId: 'q1',
      candidates: [],
      selectedInterval: 'weekly',
      suggestedInterval: null,
    });
  });

  it('ignores events that do not apply to the current state', () => {
    const state: WorkspaceState = { kind: 'empty' };
    expect(reducer(state, { type: 'TOGGLE_CANDIDATE', id: 'e1' })).toBe(state);
  });
});