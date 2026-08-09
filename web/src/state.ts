import type { CandidateEvent } from './types';

export interface SelectableCandidate extends CandidateEvent {
  selected: boolean;
}

export type WorkspaceState =
  | { kind: 'signedOut' }
  | { kind: 'linkSent' }
  | { kind: 'empty' }
  | { kind: 'loading'; queryText: string }
  | { kind: 'review'; queryId: string; candidates: SelectableCandidate[] }
  | { kind: 'feedReady'; icsUrl: string; rssUrl: string; approved: SelectableCandidate[] };

export type WorkspaceEvent =
  | { type: 'MAGIC_LINK_SENT' }
  | { type: 'SUBMIT_QUERY'; text: string }
  | { type: 'QUERY_RESOLVED'; queryId: string; candidates: CandidateEvent[] }
  | { type: 'TOGGLE_CANDIDATE'; id: string }
  | { type: 'APPROVE_RESOLVED'; icsUrl: string; rssUrl: string; approved: SelectableCandidate[] };

export function reducer(state: WorkspaceState, event: WorkspaceEvent): WorkspaceState {
  switch (event.type) {
    case 'MAGIC_LINK_SENT':
      if (state.kind !== 'signedOut') return state;
      return { kind: 'linkSent' };

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
      // `approved` comes from the event, not state.candidates here — the
      // caller must snapshot selections at the moment it sent the approve
      // request, since the user can keep toggling checkboxes while that
      // request is in flight and state.candidates would have moved on.
      return {
        kind: 'feedReady',
        icsUrl: event.icsUrl,
        rssUrl: event.rssUrl,
        approved: event.approved,
      };

    default:
      return state;
  }
}