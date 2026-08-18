import { describe, it, expect, vi } from 'vitest';
import { renderWorkspace, type WorkspaceHandlers } from './render';

function noopHandlers(): WorkspaceHandlers {
  return {
    onRequestMagicLink: vi.fn(),
    onSubmitQuery: vi.fn(),
    onToggleCandidate: vi.fn(),
    onSetReviewInterval: vi.fn(),
    onApprove: vi.fn(),
    onCancelSearch: vi.fn(),
    onStartEdit: vi.fn(),
    onToggleEditEvent: vi.fn(),
    onCancelEdit: vi.fn(),
    onSaveEdit: vi.fn(),
    onDeleteQuery: vi.fn(),
    onRotateFeedToken: vi.fn(),
    onGoToDashboard: vi.fn(),
    onStartOver: vi.fn(),
    onSignOut: vi.fn(),
  };
}

describe('renderWorkspace', () => {
  it('renders the sign-in state with a product pitch and wires the magic-link handler', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(container, { kind: 'signedOut' }, handlers);

    expect(container.textContent).toContain('Sign in');
    expect(container.textContent).toMatch(/recurring events/i);
    expect(container.firstElementChild!.classList.contains('workspace-enter')).toBe(true);
    expect(container.querySelector('.stamp-button')).not.toBeNull();
    const input = container.querySelector<HTMLInputElement>('input[type=email]')!;
    expect(input.classList.contains('ruled-input')).toBe(true);
    input.value = 'a@example.com';
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(handlers.onRequestMagicLink).toHaveBeenCalledWith('a@example.com');
  });

  it('renders the link-sent confirmation', () => {
    const container = document.createElement('div');
    renderWorkspace(container, { kind: 'linkSent' }, noopHandlers());
    expect(container.textContent).toMatch(/check your inbox/i);
    expect(container.querySelector('.ornament')).not.toBeNull();
  });

  it('renders the empty workspace and submits a query on enter', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(container, { kind: 'empty' }, handlers);

    expect(container.querySelector('.stamp-button')).not.toBeNull();
    const input = container.querySelector<HTMLInputElement>('input[name=query]')!;
    expect(input.classList.contains('ruled-input')).toBe(true);
    input.value = 'Auer Dult Munich';
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

    // The cadence is chosen on the review screen after the search returns,
    // so the empty state submits without one.
    expect(handlers.onSubmitQuery).toHaveBeenCalledWith('Auer Dult Munich');
  });

  it('prefills the query input when returning to empty after a failed search', () => {
    const container = document.createElement('div');
    renderWorkspace(container, { kind: 'empty', queryText: 'Auer Dult Munich' }, noopHandlers());

    const input = container.querySelector<HTMLInputElement>('input[name=query]')!;
    expect(input.value).toBe('Auer Dult Munich');
  });

  it('renders the no-results state with an editable term and a search-again action', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(container, { kind: 'noResults', queryText: 'Auer Dult Munich' }, handlers);

    expect(container.textContent).toMatch(/no dates found/i);
    expect(container.textContent).toContain('Auer Dult Munich');
    const input = container.querySelector<HTMLInputElement>('input[name=query]')!;
    expect(input.value).toBe('Auer Dult Munich');

    input.value = 'Auer Dult dates';
    container.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(handlers.onSubmitQuery).toHaveBeenCalledWith('Auer Dult dates');

    container.querySelector<HTMLButtonElement>('button[data-action=no-results-cancel]')!.click();
    expect(handlers.onStartOver).toHaveBeenCalled();
  });

  it('routes the no-results cancel back to the dashboard for returning users', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(container, { kind: 'noResults', queryText: 'Oktoberfest', fromDashboard: true }, handlers);

    expect(container.textContent).toMatch(/back to dashboard/i);
    container.querySelector<HTMLButtonElement>('button[data-action=no-results-cancel]')!.click();
    expect(handlers.onGoToDashboard).toHaveBeenCalled();
  });

  it('renders the loading state with a torn-ticket chip, ticking indicator, and cancel action', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(container, { kind: 'loading', queryText: 'Auer Dult Munich' }, handlers);
    expect(container.textContent).toContain('Auer Dult Munich');
    expect(container.textContent).toMatch(/searching/i);
    expect(container.querySelector('.chip-torn')).not.toBeNull();
    expect(container.querySelectorAll('.tick')).toHaveLength(3);

    container.querySelector<HTMLButtonElement>('button[data-action=cancel-search]')!.click();
    expect(handlers.onCancelSearch).toHaveBeenCalled();
  });

  it('reassures the user once a search takes longer than usual', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    renderWorkspace(container, { kind: 'loading', queryText: 'Auer Dult Munich' }, noopHandlers());

    expect(container.textContent).not.toMatch(/longer than usual/i);
    vi.advanceTimersByTime(60_000);
    expect(container.textContent).toMatch(/longer than usual/i);

    vi.useRealTimers();
  });

  it('does not touch a stale loading message after the state moves on', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    renderWorkspace(container, { kind: 'loading', queryText: 'Auer Dult Munich' }, noopHandlers());
    renderWorkspace(container, { kind: 'empty' }, noopHandlers());

    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    expect(container.textContent).not.toMatch(/longer than usual/i);

    vi.useRealTimers();
  });

  it('renders candidates as calendar-day tiles and toggles selection on click', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'review',
        queryId: 'q1',
        candidates: [
          {
            id: 'e1',
            label: 'Frühjahrsdult',
            startDate: '2026-04-11',
            endDate: '2026-04-11',
            sourceUrl: 'u',
            status: 'candidate',
            selected: true,
          },
        ],
        selectedInterval: 'yearly',
        suggestedInterval: 'yearly',
      },
      handlers
    );

    expect(container.textContent).toContain('Frühjahrsdult');
    expect(container.textContent).toContain('APR');
    expect(container.textContent).toContain('11');
    expect(container.querySelector('.day-tile')!.classList.contains('day-tile-selected')).toBe(true);

    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
    expect(handlers.onToggleCandidate).toHaveBeenCalledWith('e1');

    container.querySelector<HTMLButtonElement>('button[data-action=approve]')!.click();
    expect(handlers.onApprove).toHaveBeenCalled();
  });

  it('shows the cadence selector pre-filled with the AI suggestion and explains approval', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'review',
        queryId: 'q1',
        candidates: [],
        selectedInterval: 'yearly',
        suggestedInterval: 'yearly',
      },
      handlers
    );

    const select = container.querySelector<HTMLSelectElement>('select[name=reviewInterval]')!;
    expect(select.value).toBe('yearly');
    expect(container.textContent).toMatch(/AI suggested Every year/i);
    expect(container.textContent).toMatch(/private calendar feed/i);

    select.value = 'quarterly';
    select.dispatchEvent(new Event('change'));
    expect(handlers.onSetReviewInterval).toHaveBeenCalledWith('quarterly');
  });

  it('shows a date range and an unselected style when start and end differ', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'review',
        queryId: 'q1',
        candidates: [
          {
            id: 'e2',
            label: 'Oktoberfest',
            startDate: '2026-09-19',
            endDate: '2026-10-04',
            sourceUrl: 'u',
            status: 'candidate',
            selected: false,
          },
        ],
        selectedInterval: 'weekly',
        suggestedInterval: null,
      },
      noopHandlers()
    );

    expect(container.textContent).toContain('SEP 19, 2026–OCT 4, 2026');
    expect(container.querySelector('.day-tile')!.classList.contains('day-tile-selected')).toBe(false);
  });

  it('only replays the enter animation on an actual state change, not a same-state re-render', () => {
    const container = document.createElement('div');
    const candidate = {
      id: 'e1',
      label: 'Frühjahrsdult',
      startDate: '2026-04-11',
      endDate: '2026-04-11',
      sourceUrl: 'u',
      status: 'candidate' as const,
      selected: true,
    };
    renderWorkspace(
      container,
      { kind: 'review', queryId: 'q1', candidates: [candidate], selectedInterval: 'yearly', suggestedInterval: 'yearly' },
      noopHandlers()
    );
    expect(container.firstElementChild!.classList.contains('workspace-enter')).toBe(true);

    renderWorkspace(
      container,
      { kind: 'review', queryId: 'q1', candidates: [{ ...candidate, selected: false }], selectedInterval: 'yearly', suggestedInterval: 'yearly' },
      noopHandlers()
    );
    expect(container.firstElementChild!.classList.contains('workspace-enter')).toBe(false);

    renderWorkspace(container, { kind: 'loading', queryText: 'x' }, noopHandlers());
    expect(container.firstElementChild!.classList.contains('workspace-enter')).toBe(true);
  });

  it('falls back to the raw string for a malformed date instead of "undefined"', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'review',
        queryId: 'q1',
        candidates: [
          {
            id: 'e3',
            label: 'Mystery Fest',
            startDate: 'not-a-date',
            endDate: 'not-a-date',
            sourceUrl: 'u',
            status: 'candidate',
            selected: false,
          },
        ],
        selectedInterval: 'weekly',
        suggestedInterval: null,
      },
      noopHandlers()
    );

    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).toContain('not-a-date');
    expect(container.querySelector('.day-tile-month')!.textContent).toBe('?');
    expect(container.querySelector('.day-tile-day')!.textContent).toBe('?');
  });

  it('renders the feed-ready state with both URLs, copy buttons, and exits', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'feedReady',
        icsUrl: 'https://x/f/t.ics',
        rssUrl: 'https://x/f/t.rss',
        approved: [],
      },
      handlers
    );

    expect(container.textContent).toContain('Your feed is ready');
    expect(container.textContent).toContain('https://x/f/t.ics');
    expect(container.textContent).toContain('https://x/f/t.rss');
    expect(container.querySelectorAll('.ledger-row')).toHaveLength(2);
    expect(container.querySelectorAll('.copy-button')).toHaveLength(2);
    expect(container.querySelectorAll('.feed-action')).toHaveLength(7);

    const downloadLink = container.querySelector<HTMLAnchorElement>('a.feed-action[download]')!;
    expect(downloadLink.getAttribute('href')).toBe('https://x/f/t.ics');
    expect(downloadLink.getAttribute('aria-label')).toBe('Download ICS');

    const actionLinks = container.querySelectorAll<HTMLAnchorElement>('a.feed-action');
    expect(actionLinks[1].getAttribute('href')).toBe(
      `https://calendar.google.com/calendar/r?cid=${encodeURIComponent('webcal://x/f/t.ics')}`
    );
    expect(actionLinks[2].getAttribute('href')).toBe('webcal://x/f/t.ics');
    expect(actionLinks[3].getAttribute('href')).toBe(
      `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent('webcal://x/f/t.ics')}`
    );

    const rssActions = container.querySelectorAll<HTMLElement>('.feed-actions')[1];
    const rssLink = rssActions.querySelector<HTMLAnchorElement>('a.feed-action')!;
    expect(rssLink.getAttribute('href')).toBe('https://x/f/t.rss');
    expect(rssLink.getAttribute('aria-label')).toBe('Open RSS feed');

    container.querySelector<HTMLButtonElement>('button[data-action=dashboard]')!.click();
    expect(handlers.onGoToDashboard).toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>('button[data-action=search-another]')!.click();
    expect(handlers.onStartOver).toHaveBeenCalled();
  });

  it('swaps the copy icon for a check when a copy button is clicked', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      { kind: 'feedReady', icsUrl: 'https://x/f/t.ics', rssUrl: 'https://x/f/t.rss', approved: [] },
      noopHandlers()
    );

    const copyButton = container.querySelector<HTMLButtonElement>('.copy-button')!;
    copyButton.click();
    expect(copyButton.querySelector('.icon-check')).not.toBeNull();
  });

  it('renders the dashboard with saved queries, schedules, counts and feed info', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [
          { id: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'quarterly', lastRunAt: '2026-08-10T09:00:00Z', createdAt: '2026-08-01T00:00:00Z', approvedCount: 2, candidateCount: 1 },
        ],
        feed: { icsUrl: 'https://x/f/t.ics', rssUrl: 'https://x/f/t.rss', lastFetchedAt: '2026-08-10T11:30:00Z' },
        editing: null,
      },
      handlers
    );

    expect(container.textContent).toContain('Auer Dult Munich');
    expect(container.textContent).toContain('Every quarter');
    expect(container.textContent).toContain('2 approved');
    expect(container.textContent).toContain('1 pending approval');
    expect(container.textContent).toContain('https://x/f/t.ics');
    expect(container.textContent).toContain('https://x/f/t.rss');
    expect(container.querySelectorAll('.feed-summary .copy-button')).toHaveLength(2);
    expect(container.querySelectorAll('.feed-summary .feed-action')).toHaveLength(7);

    container.querySelector<HTMLButtonElement>('.query-card button[data-action=edit]')!.click();
    expect(handlers.onStartEdit).toHaveBeenCalledWith('q1');
  });

  it('shows a hint instead of feed links until the user has approved something', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      { kind: 'dashboard', queries: [], feed: null, editing: null },
      noopHandlers()
    );
    expect(container.textContent).toMatch(/no calendar yet/i);
  });

  it('submits a new query from the dashboard; cadence is chosen later on review', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      { kind: 'dashboard', queries: [], feed: null, editing: null },
      handlers
    );

    const input = container.querySelector<HTMLInputElement>('.dashboard-add input[name=query]')!;
    input.value = 'Oktoberfest Munich';
    container.querySelector<HTMLFormElement>('.dashboard-add')!.dispatchEvent(new Event('submit', { cancelable: true }));

    expect(handlers.onSubmitQuery).toHaveBeenCalledWith('Oktoberfest Munich');
    expect(container.querySelector('.dashboard-add select')).toBeNull();
  });

  it('signs out from the dashboard', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      { kind: 'dashboard', queries: [], feed: null, editing: null },
      handlers
    );

    container.querySelector<HTMLButtonElement>('button[data-action=sign-out]')!.click();
    expect(handlers.onSignOut).toHaveBeenCalled();
  });

  it('renders an editing card prefilled and saves the edited values', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [
          { id: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'quarterly', lastRunAt: null, createdAt: '2026-08-01T00:00:00Z', approvedCount: 0, candidateCount: 0 },
        ],
        feed: null,
        editing: { queryId: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'quarterly', events: [] },
      },
      handlers
    );

    const textInput = container.querySelector<HTMLInputElement>('.edit-form input[name=editText]')!;
    expect(textInput.value).toBe('Auer Dult Munich');
    const intervalSelect = container.querySelector<HTMLSelectElement>('.edit-form select[name=editInterval]')!;
    expect(intervalSelect.value).toBe('quarterly');

    textInput.value = 'Auer Dult cans';
    intervalSelect.value = 'weekly';
    container.querySelector<HTMLFormElement>('.edit-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(handlers.onSaveEdit).toHaveBeenCalledWith('q1', { text: 'Auer Dult cans', recurrenceInterval: 'weekly' });

    container.querySelector<HTMLButtonElement>('.edit-form button[data-action=cancel]')!.click();
    expect(handlers.onCancelEdit).toHaveBeenCalled();
  });

  it('shows the events inside the edit card and toggles pending candidates', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [
          { id: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'quarterly', lastRunAt: null, createdAt: '2026-08-01T00:00:00Z', approvedCount: 1, candidateCount: 1 },
        ],
        feed: null,
        editing: {
          queryId: 'q1',
          text: 'Auer Dult Munich',
          recurrenceInterval: 'quarterly',
          events: [
            { id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u1', status: 'approved', selected: false },
            { id: 'e2', label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'u2', status: 'candidate', selected: true },
          ],
        },
      },
      handlers
    );

    expect(container.textContent).toContain('approved');
    const checkbox = container.querySelector<HTMLInputElement>('.edit-form .day-tile input[type=checkbox]')!;
    expect(checkbox.checked).toBe(true);
    checkbox.click();
    expect(handlers.onToggleEditEvent).toHaveBeenCalledWith('e2');
  });

  it('deleting a query requires a confirmation click before calling the handler', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [
          { id: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'quarterly', lastRunAt: null, createdAt: '2026-08-01T00:00:00Z', approvedCount: 0, candidateCount: 0 },
        ],
        feed: null,
        editing: null,
      },
      handlers
    );

    const deleteButton = container.querySelector<HTMLButtonElement>('.query-card button[data-action=delete]')!;
    deleteButton.click();
    expect(handlers.onDeleteQuery).not.toHaveBeenCalled();
    expect(deleteButton.textContent).toContain('Confirm');
    deleteButton.click();
    expect(handlers.onDeleteQuery).toHaveBeenCalledWith('q1');
  });
});