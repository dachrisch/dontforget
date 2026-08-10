import { describe, it, expect } from 'vitest';
import { reducer, type WorkspaceState } from './state';
import type { QuerySummary } from './types';

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

  it('moves from loading to review with all candidates pre-selected', () => {
    const state: WorkspaceState = { kind: 'loading', queryText: 'Auer Dult Munich' };
    const next = reducer(state, {
      type: 'QUERY_RESOLVED',
      queryId: 'q1',
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
    });
  });

  it('toggles one candidate without touching the others', () => {
    const state: WorkspaceState = {
      kind: 'review',
      queryId: 'q1',
      candidates: [
        { id: 'e1', label: 'A', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u', status: 'candidate', selected: true },
        { id: 'e2', label: 'B', startDate: '2026-01-02', endDate: '2026-01-02', sourceUrl: 'u', status: 'candidate', selected: true },
      ],
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
      editing: { queryId: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'quarterly' },
    });
  });

  it('cancels editing', () => {
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [],
      feed: null,
      editing: { queryId: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'monthly' },
    };
    const next = reducer(state, { type: 'CANCEL_EDIT' });
    expect(next).toEqual({ kind: 'dashboard', queries: [], feed: null, editing: null });
  });

  it('applies a saved update to the list and exits editing', () => {
    const query: QuerySummary = { id: 'q1', text: 'Auer Dult Munich dates', recurrenceInterval: 'yearly', lastRunAt: null, createdAt: '2026-08-10T00:00:00Z', approvedCount: 0, candidateCount: 0 };
    const state: WorkspaceState = {
      kind: 'dashboard',
      queries: [{ ...query, text: 'Auer Dult Munich', recurrenceInterval: 'monthly' }],
      feed: null,
      editing: null,
    };
    const next = reducer(state, { type: 'QUERY_UPDATED', query });
    expect(next).toMatchObject({ kind: 'dashboard', queries: [query], editing: null });
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
      candidates: [{ id: 'e1', label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-10-04', sourceUrl: 'u', status: 'candidate' }],
    });
    expect(next).toMatchObject({ kind: 'review', fromDashboard: true });
  });

  it('does not tag review with a return path for first-time searches', () => {
    const state: WorkspaceState = { kind: 'loading', queryText: 'Oktoberfest' };
    const next = reducer(state, {
      type: 'QUERY_RESOLVED',
      queryId: 'q1',
      candidates: [],
    });
    expect(next).toEqual({ kind: 'review', queryId: 'q1', candidates: [] });
  });

  it('ignores events that do not apply to the current state', () => {
    const state: WorkspaceState = { kind: 'empty' };
    expect(reducer(state, { type: 'TOGGLE_CANDIDATE', id: 'e1' })).toBe(state);
  });
});