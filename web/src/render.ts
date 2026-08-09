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
    <p class="subtext">No password — we'll email you a link.</p>
    <form class="ruled-form">
      <input class="ruled-input" type="email" name="email" placeholder="you@example.com" required />
      <button class="stamp-button" type="submit">Email me a link</button>
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
  wrapper.innerHTML = `
    <p class="ornament">※</p>
    <p>Check your inbox — the link signs you in.</p>
  `;
  return wrapper;
}

function renderEmpty(handlers: WorkspaceHandlers): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <form class="ruled-form">
      <label class="entry-label" for="query-input">What do you want to track?</label>
      <input class="ruled-input" id="query-input" name="query" placeholder="e.g. Auer Dult Munich" required />
      <button class="stamp-button" type="submit">Search</button>
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
    <span class="chip-torn">${escapeHtml(queryText)}</span>
    <p class="loading-status">
      Searching → extracting dates…
      <span class="ticks">
        <span class="tick"></span>
        <span class="tick"></span>
        <span class="tick"></span>
      </span>
    </p>
  `;
  return wrapper;
}

const MONTH_ABBREVS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function parseIsoDate(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

function monthAbbrev(iso: string): string {
  return MONTH_ABBREVS[parseIsoDate(iso).month - 1];
}

function dayNumber(iso: string): string {
  return String(parseIsoDate(iso).day);
}

function formatIsoDate(iso: string): string {
  const { year, month, day } = parseIsoDate(iso);
  return `${MONTH_ABBREVS[month - 1]} ${day}, ${year}`;
}

function formatRange(startDate: string, endDate: string): string {
  if (startDate === endDate) return formatIsoDate(startDate);
  return `${formatIsoDate(startDate)}–${formatIsoDate(endDate)}`;
}

function renderReview(
  candidates: Array<{ id: string; label: string; startDate: string; endDate: string; sourceUrl: string; selected: boolean }>,
  handlers: WorkspaceHandlers
): HTMLElement {
  const wrapper = document.createElement('div');
  const tiles = candidates
    .map(
      c => `
      <label class="day-tile ${c.selected ? 'day-tile-selected' : ''}" data-id="${c.id}">
        <input type="checkbox" ${c.selected ? 'checked' : ''} />
        <span class="day-tile-month">${monthAbbrev(c.startDate)}</span>
        <span class="day-tile-day">${dayNumber(c.startDate)}</span>
        <span class="day-tile-caption">${escapeHtml(formatRange(c.startDate, c.endDate))} · ${escapeHtml(c.label)}</span>
        <a class="day-tile-source" href="${escapeHtml(c.sourceUrl)}" target="_blank" rel="noopener">source</a>
      </label>`
    )
    .join('');
  wrapper.innerHTML = `
    <div class="tile-grid">${tiles}</div>
    <button class="stamp-button" type="button" data-action="approve">Approve selected (${candidates.filter(c => c.selected).length})</button>
  `;
  wrapper.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(checkbox => {
    checkbox.addEventListener('click', () => {
      const id = checkbox.closest<HTMLElement>('.day-tile')!.dataset.id!;
      handlers.onToggleCandidate(id);
    });
  });
  wrapper.querySelectorAll<HTMLAnchorElement>('.day-tile-source').forEach(a => {
    a.addEventListener('click', e => e.stopPropagation());
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