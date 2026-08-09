import { describe, it, expect } from 'vitest';
import { reducer, type WorkspaceState } from './state';

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

  it('ignores events that do not apply to the current state', () => {
    const state: WorkspaceState = { kind: 'empty' };
    expect(reducer(state, { type: 'TOGGLE_CANDIDATE', id: 'e1' })).toBe(state);
  });
});