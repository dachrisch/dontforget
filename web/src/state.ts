import type { CandidateEvent } from './types';

export interface SelectableCandidate extends CandidateEvent {
  selected: boolean;
}

export type WorkspaceState =
  | { kind: 'signedOut' }
  | { kind: 'empty' }
  | { kind: 'loading'; queryText: string }
  | { kind: 'review'; queryId: string; candidates: SelectableCandidate[] }
  | { kind: 'feedReady'; icsUrl: string; rssUrl: string; approved: SelectableCandidate[] };

export type WorkspaceEvent =
  | { type: 'SUBMIT_QUERY'; text: string }
  | { type: 'QUERY_RESOLVED'; queryId: string; candidates: CandidateEvent[] }
  | { type: 'TOGGLE_CANDIDATE'; id: string }
  | { type: 'APPROVE_RESOLVED'; icsUrl: string; rssUrl: string };

export function reducer(state: WorkspaceState, event: WorkspaceEvent): WorkspaceState {
  switch (event.type) {
    case 'SUBMIT_QUERY':
      if (state.kind !== 'empty') return state;
      return { kind: 'loading', queryText: event.text };

    case 'QUERY_RESOLVED':
      if (state.kind !== 'loading') return state;
      return {
        kind: 'review',
        queryId: event.queryId,
        candidates: event.candidates.map(c => ({ ...c, selected: true })),
      };

    case 'TOGGLE_CANDIDATE':
      if (state.kind !== 'review') return state;
      return {
        ...state,
        candidates: state.candidates.map(c => (c.id === event.id ? { ...c, selected: !c.selected } : c)),
      };

    case 'APPROVE_RESOLVED':
      if (state.kind !== 'review') return state;
      return {
        kind: 'feedReady',
        icsUrl: event.icsUrl,
        rssUrl: event.rssUrl,
        approved: state.candidates.filter(c => c.selected),
      };

    default:
      return state;
  }
}