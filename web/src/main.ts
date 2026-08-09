import './style.css';
import { reducer, type WorkspaceState } from './state';
import { renderWorkspace } from './render';
import { requestMagicLink, checkSession, submitQuery, approveEvents } from './api';
import { renderMasthead } from './masthead';

const root = document.getElementById('root')!;
root.before(renderMasthead());

const errorBanner = document.createElement('p');
errorBanner.className = 'error-banner';
errorBanner.hidden = true;
root.before(errorBanner);

function showError(context: string, err: unknown): void {
  console.error(`[dontforget] ${context} failed:`, err);
  errorBanner.textContent = `Something went wrong while ${context}. Please try again.`;
  errorBanner.hidden = false;
}

function clearError(): void {
  errorBanner.hidden = true;
}

let state: WorkspaceState = { kind: 'signedOut' };

function setState(next: WorkspaceState) {
  state = next;
  paint();
}

function paint() {
  renderWorkspace(root, state, {
    onRequestMagicLink: email => {
      clearError();
      requestMagicLink(email)
        .then(() => setState(reducer(state, { type: 'MAGIC_LINK_SENT' })))
        .catch(err => showError('requesting your sign-in link', err));
    },
    onSubmitQuery: text => {
      clearError();
      setState(reducer(state, { type: 'SUBMIT_QUERY', text }));
      submitQuery(text)
        .then(({ queryId, candidates }) => {
          setState(reducer(state, { type: 'QUERY_RESOLVED', queryId, candidates }));
        })
        .catch(err => showError('searching', err));
    },
    onToggleCandidate: id => {
      setState(reducer(state, { type: 'TOGGLE_CANDIDATE', id }));
    },
    onApprove: () => {
      if (state.kind !== 'review') return;
      // Snapshot the current selection now — the user can keep toggling
      // checkboxes while this request is in flight, and the confirmation
      // screen must reflect what was actually sent (and persisted), not
      // whatever `state` has drifted to by the time the response arrives.
      const approved = state.candidates.filter(c => c.selected);
      const eventIds = approved.map(c => c.id);
      clearError();
      approveEvents(state.queryId, eventIds)
        .then(({ icsUrl, rssUrl }) => {
          setState(reducer(state, { type: 'APPROVE_RESOLVED', icsUrl, rssUrl, approved }));
        })
        .catch(err => showError('approving events', err));
    },
  });
}

checkSession()
  .then(authenticated => {
    setState(authenticated ? { kind: 'empty' } : { kind: 'signedOut' });
  })
  .catch(err => {
    showError('loading dontforget', err);
    setState({ kind: 'signedOut' });
  });