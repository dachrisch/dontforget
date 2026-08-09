import { reducer, type WorkspaceState } from './state';
import { renderWorkspace } from './render';
import { requestMagicLink, checkSession, submitQuery, approveEvents } from './api';

const root = document.getElementById('root')!;

let state: WorkspaceState = { kind: 'signedOut' };

function setState(next: WorkspaceState) {
  state = next;
  paint();
}

function paint() {
  renderWorkspace(root, state, {
    onRequestMagicLink: email => {
      requestMagicLink(email).then(() => {
        root.innerHTML = '<p>Check your inbox — the link signs you in.</p>';
      });
    },
    onSubmitQuery: text => {
      setState(reducer(state, { type: 'SUBMIT_QUERY', text }));
      submitQuery(text).then(({ queryId, candidates }) => {
        setState(reducer(state, { type: 'QUERY_RESOLVED', queryId, candidates }));
      });
    },
    onToggleCandidate: id => {
      setState(reducer(state, { type: 'TOGGLE_CANDIDATE', id }));
    },
    onApprove: () => {
      if (state.kind !== 'review') return;
      const eventIds = state.candidates.filter(c => c.selected).map(c => c.id);
      approveEvents(state.queryId, eventIds).then(({ icsUrl, rssUrl }) => {
        setState(reducer(state, { type: 'APPROVE_RESOLVED', icsUrl, rssUrl }));
      });
    },
  });
}

checkSession().then(authenticated => {
  setState(authenticated ? { kind: 'empty' } : { kind: 'signedOut' });
});