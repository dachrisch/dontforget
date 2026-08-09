import type { WorkspaceState } from './state';

export interface WorkspaceHandlers {
  onRequestMagicLink: (email: string) => void;
  onSubmitQuery: (text: string) => void;
  onToggleCandidate: (id: string) => void;
  onApprove: () => void;
}

export function renderWorkspace(
  container: HTMLElement,
  state: WorkspaceState,
  handlers: WorkspaceHandlers
): void {
  container.innerHTML = '';
  const wrapper = render(state, handlers);
  wrapper.classList.add('workspace-enter');
  container.appendChild(wrapper);
}

function render(state: WorkspaceState, handlers: WorkspaceHandlers): HTMLElement {
  switch (state.kind) {
    case 'signedOut':
      return renderSignedOut(handlers);
    case 'linkSent':
      return renderLinkSent();
    case 'empty':
      return renderEmpty(handlers);
    case 'loading':
      return renderLoading(state.queryText);
    case 'review':
      return renderReview(state.candidates, handlers);
    case 'feedReady':
      return renderFeedReady(state.icsUrl, state.rssUrl);
  }
}

function renderSignedOut(handlers: WorkspaceHandlers): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <h1>Sign in</h1>
    <p>No password — we'll email you a link.</p>
    <form>
      <input type="email" name="email" placeholder="you@example.com" required />
      <button type="submit">Email me a link</button>
    </form>
  `;
  wrapper.querySelector('form')!.addEventListener('submit', e => {
    e.preventDefault();
    const email = wrapper.querySelector<HTMLInputElement>('input[type=email]')!.value;
    handlers.onRequestMagicLink(email);
  });
  return wrapper;
}

function renderLinkSent(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `<p>Check your inbox — the link signs you in.</p>`;
  return wrapper;
}

function renderEmpty(handlers: WorkspaceHandlers): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <form>
      <input name="query" placeholder="What do you want to track?" required />
      <button type="submit">Search</button>
    </form>
  `;
  wrapper.querySelector('form')!.addEventListener('submit', e => {
    e.preventDefault();
    const text = wrapper.querySelector<HTMLInputElement>('input[name=query]')!.value;
    handlers.onSubmitQuery(text);
  });
  return wrapper;
}

function renderLoading(queryText: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <span class="chip">${escapeHtml(queryText)}</span>
    <p>Searching → extracting dates…</p>
  `;
  return wrapper;
}

function renderReview(
  candidates: Array<{ id: string; label: string; startDate: string; endDate: string; sourceUrl: string; selected: boolean }>,
  handlers: WorkspaceHandlers
): HTMLElement {
  const wrapper = document.createElement('div');
  const rows = candidates
    .map(
      c => `
      <div class="cand-row" data-id="${c.id}">
        <input type="checkbox" ${c.selected ? 'checked' : ''} />
        <span>${escapeHtml(c.startDate)}–${escapeHtml(c.endDate)} · ${escapeHtml(c.label)}</span>
        <a href="${escapeHtml(c.sourceUrl)}">source</a>
      </div>`
    )
    .join('');
  wrapper.innerHTML = `
    ${rows}
    <button type="button" data-action="approve">Approve selected (${candidates.filter(c => c.selected).length})</button>
  `;
  wrapper.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(checkbox => {
    checkbox.addEventListener('click', () => {
      const id = checkbox.closest<HTMLElement>('.cand-row')!.dataset.id!;
      handlers.onToggleCandidate(id);
    });
  });
  wrapper.querySelector('button[data-action=approve]')!.addEventListener('click', () => {
    handlers.onApprove();
  });
  return wrapper;
}

function renderFeedReady(icsUrl: string, rssUrl: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <p>Future runs add new dates automatically — nothing to approve next time.</p>
    <div>ICS: <a href="${escapeHtml(icsUrl)}">${escapeHtml(icsUrl)}</a></div>
    <div>RSS: <a href="${escapeHtml(rssUrl)}">${escapeHtml(rssUrl)}</a></div>
  `;
  return wrapper;
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}