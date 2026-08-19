import { describe, it, expect, vi } from 'vitest';
import { renderWorkspace, type WorkspaceHandlers } from './render';
import type { QuerySummary } from './types';

function noopHandlers(): WorkspaceHandlers {
  return {
    onRequestMagicLink: vi.fn(),
    onSubmitQuery: vi.fn(),
    onStartEdit: vi.fn(),
    onToggleEditEvent: vi.fn(),
    onCancelEdit: vi.fn(),
    onSaveEdit: vi.fn(),
    onDeleteQuery: vi.fn(),
    onRotateFeedToken: vi.fn(),
    onSignOut: vi.fn(),
    onDeleteAccount: vi.fn(),
    onStartReview: vi.fn(),
    onToggleReviewEvent: vi.fn(),
    onSetReviewInterval: vi.fn(),
    onApproveReview: vi.fn(),
    onCancelReview: vi.fn(),
    onRetrySearch: vi.fn(),
    onCloseAdmin: vi.fn(),
    onDeleteAdminUser: vi.fn(),
    onUpgrade: vi.fn(),
    onManageBilling: vi.fn(),
    onSetAdminModel: vi.fn(),
    onAddAdminModel: vi.fn(),
  };
}

function query(overrides: Partial<QuerySummary> = {}): QuerySummary {
  return {
    id: 'q1',
    text: 'Auer Dult Munich',
    recurrenceInterval: 'quarterly',
    lastRunAt: null,
    createdAt: '2026-08-01T00:00:00Z',
    approvedCount: 0,
    candidateCount: 0,
    status: 'ready',
    ...overrides,
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

    // The cadence is chosen on the review card after the search lands, so
    // the empty state submits without one.
    expect(handlers.onSubmitQuery).toHaveBeenCalledWith('Auer Dult Munich');
  });

  it('renders a running query card with a ticking indicator', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      { kind: 'dashboard', queries: [query({ text: 'Oktoberfest', status: 'running' })], feed: null, editing: null, reviewing: null, billing: null },
      handlers
    );

    expect(container.textContent).toContain('Oktoberfest');
    expect(container.textContent).toMatch(/searching/i);
    expect(container.querySelectorAll('.tick')).toHaveLength(3);
    expect(container.querySelector('.query-card-running')).not.toBeNull();
  });

  it('reassures the user once a search takes longer than usual', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    renderWorkspace(
      container,
      { kind: 'dashboard', queries: [query({ status: 'running' })], feed: null, editing: null, reviewing: null, billing: null },
      noopHandlers()
    );

    expect(container.textContent).not.toMatch(/longer than usual/i);
    vi.advanceTimersByTime(60_000);
    expect(container.textContent).toMatch(/longer than usual/i);

    vi.useRealTimers();
  });

  it('does not touch a stale running status after the state moves on', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    renderWorkspace(
      container,
      { kind: 'dashboard', queries: [query({ status: 'running' })], feed: null, editing: null, reviewing: null, billing: null },
      noopHandlers()
    );
    renderWorkspace(container, { kind: 'empty' }, noopHandlers());

    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    expect(container.textContent).not.toMatch(/longer than usual/i);

    vi.useRealTimers();
  });

  it('renders a failed query card with a retry action', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      { kind: 'dashboard', queries: [query({ status: 'failed' })], feed: null, editing: null, reviewing: null, billing: null },
      handlers
    );

    expect(container.textContent).toMatch(/failed/i);
    container.querySelector<HTMLButtonElement>('.query-card button[data-action=retry]')!.click();
    expect(handlers.onRetrySearch).toHaveBeenCalledWith('q1');
  });

  it('shows a review action on a ready card that has pending candidates', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      { kind: 'dashboard', queries: [query({ candidateCount: 3, approvedCount: 1 })], feed: null, editing: null, reviewing: null, billing: null },
      handlers
    );

    expect(container.textContent).toContain('1 approved');
    expect(container.textContent).toContain('3 pending approval');
    container.querySelector<HTMLButtonElement>('.query-card button[data-action=review]')!.click();
    expect(handlers.onStartReview).toHaveBeenCalledWith('q1');
  });

  it('renders the reviewing card with candidate tiles and wires approve/cancel', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [query({ candidateCount: 1 })],
        feed: null,
        editing: null, billing: null,
        reviewing: {
          queryId: 'q1',
          recurrenceInterval: 'yearly',
          events: [
            {
              id: 'e1',
              label: 'Frühjahrsdult',
              startDate: '2026-04-11',
              endDate: '2026-04-11',
              sourceUrl: 'u',
              status: 'candidate',
              decision: 'approve',
            },
          ],
        },
      },
      handlers
    );

    expect(container.querySelector('.query-card-reviewing')).not.toBeNull();
    expect(container.textContent).toContain('Frühjahrsdult');
    expect(container.textContent).toContain('APR');
    expect(container.textContent).toContain('11');
    expect(container.querySelector('.day-tile')!.classList.contains('day-tile-decision-approve')).toBe(true);

    const checkbox = container.querySelector<HTMLInputElement>('.query-card-reviewing .day-tile input[type=checkbox]')!;
    checkbox.click();
    expect(handlers.onToggleReviewEvent).toHaveBeenCalledWith('e1');

    container.querySelector<HTMLButtonElement>('button[data-action=approve-review]')!.click();
    expect(handlers.onApproveReview).toHaveBeenCalledWith('q1');

    container.querySelector<HTMLButtonElement>('button[data-action=cancel-review]')!.click();
    expect(handlers.onCancelReview).toHaveBeenCalled();
  });

  it('shows the cadence selector pre-filled from the query and explains approval', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [query()],
        feed: null,
        editing: null, billing: null,
        reviewing: { queryId: 'q1', recurrenceInterval: 'yearly', events: [] },
      },
      handlers
    );

    const select = container.querySelector<HTMLSelectElement>('select[name=reviewInterval]')!;
    expect(select.value).toBe('yearly');
    expect(container.textContent).toMatch(/private calendar feed/i);

    select.value = 'quarterly';
    select.dispatchEvent(new Event('change'));
    expect(handlers.onSetReviewInterval).toHaveBeenCalledWith('quarterly');
  });

  it('shows a date range and a neutral style when start and end differ', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [query()],
        feed: null,
        editing: null, billing: null,
        reviewing: {
          queryId: 'q1',
          recurrenceInterval: 'weekly',
          events: [
            {
              id: 'e2',
              label: 'Oktoberfest',
              startDate: '2026-09-19',
              endDate: '2026-10-04',
              sourceUrl: 'u',
              status: 'candidate',
              decision: 'none',
            },
          ],
        },
      },
      noopHandlers()
    );

    expect(container.textContent).toContain('SEP 19, 2026–OCT 4, 2026');
    expect(container.querySelector('.day-tile')!.classList.contains('day-tile-decision-approve')).toBe(false);
  });

  it('only replays the enter animation on an actual state change, not a same-state re-render', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      { kind: 'dashboard', queries: [query()], feed: null, editing: null, reviewing: null, billing: null },
      noopHandlers()
    );
    expect(container.firstElementChild!.classList.contains('workspace-enter')).toBe(true);

    renderWorkspace(
      container,
      { kind: 'dashboard', queries: [query()], feed: null, editing: null, reviewing: null, billing: null },
      noopHandlers()
    );
    expect(container.firstElementChild!.classList.contains('workspace-enter')).toBe(false);

    renderWorkspace(container, { kind: 'empty' }, noopHandlers());
    expect(container.firstElementChild!.classList.contains('workspace-enter')).toBe(true);
  });

  it('falls back to the raw string for a malformed date instead of "undefined"', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [query()],
        feed: null,
        editing: null, billing: null,
        reviewing: {
          queryId: 'q1',
          recurrenceInterval: 'weekly',
          events: [
            {
              id: 'e3',
              label: 'Mystery Fest',
              startDate: 'not-a-date',
              endDate: 'not-a-date',
              sourceUrl: 'u',
              status: 'candidate',
              decision: 'none',
            },
          ],
        },
      },
      noopHandlers()
    );

    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).toContain('not-a-date');
    expect(container.querySelector('.day-tile-month')!.textContent).toBe('?');
    expect(container.querySelector('.day-tile-day')!.textContent).toBe('?');
  });

  it('renders the dashboard with feed add buttons, copy actions, schedules and counts', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [
          query({ text: 'Auer Dult Munich', recurrenceInterval: 'quarterly', lastRunAt: '2026-08-10T09:00:00Z', approvedCount: 2, candidateCount: 1 }),
        ],
        feed: { icsUrl: 'https://x/f/t.ics', rssUrl: 'https://x/f/t.rss', lastFetchedAt: '2026-08-10T11:30:00Z' },
        editing: null,
        reviewing: null,
        billing: null,
      },
      handlers
    );

    expect(container.textContent).toContain('Auer Dult Munich');
    expect(container.textContent).toContain('Every quarter');
    expect(container.textContent).toContain('2 approved');
    expect(container.textContent).toContain('1 pending approval');
    // The raw feed URLs are hidden in favor of the action buttons.
    expect(container.textContent).not.toContain('https://x/f/');
    expect(container.querySelectorAll('.feed-summary .copy-button')).toHaveLength(2);
    expect(container.querySelectorAll('.feed-summary .feed-action')).toHaveLength(4);
    expect(container.querySelectorAll('.feed-summary .feed-add-button')).toHaveLength(3);

    const downloadLink = container.querySelector<HTMLAnchorElement>('.feed-summary a.feed-action[download]')!;
    expect(downloadLink.getAttribute('href')).toBe('https://x/f/t.ics');
    expect(downloadLink.getAttribute('aria-label')).toBe('Download ICS');

    const addButtons = container.querySelectorAll<HTMLAnchorElement>('.feed-add-button');
    expect(addButtons[0].getAttribute('href')).toBe(
      `https://calendar.google.com/calendar/r?cid=${encodeURIComponent('webcal://x/f/t.ics')}`
    );
    expect(addButtons[1].getAttribute('href')).toBe('webcal://x/f/t.ics');
    expect(addButtons[2].getAttribute('href')).toBe(
      `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent('webcal://x/f/t.ics')}`
    );

    container.querySelector<HTMLButtonElement>('.query-card button[data-action=edit]')!.click();
    expect(handlers.onStartEdit).toHaveBeenCalledWith('q1');
  });

  it('swaps the copy icon for a check when a copy button is clicked', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [],
        feed: { icsUrl: 'https://x/f/t.ics', rssUrl: 'https://x/f/t.rss', lastFetchedAt: null },
        editing: null,
        reviewing: null,
        billing: null,
      },
      noopHandlers()
    );

    const copyButton = container.querySelector<HTMLButtonElement>('.copy-button')!;
    copyButton.click();
    expect(copyButton.querySelector('.icon-check')).not.toBeNull();
  });

  it('shows a hint instead of feed links until the user has approved something', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      { kind: 'dashboard', queries: [], feed: null, editing: null, reviewing: null, billing: null },
      noopHandlers()
    );
    expect(container.textContent).toMatch(/no calendar yet/i);
  });

  it('submits a new query from the dashboard; cadence is chosen later on review', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      { kind: 'dashboard', queries: [], feed: null, editing: null, reviewing: null, billing: null },
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
      { kind: 'dashboard', queries: [], feed: null, editing: null, reviewing: null, billing: null },
      handlers
    );

    container.querySelector<HTMLButtonElement>('button[data-action=sign-out]')!.click();
    expect(handlers.onSignOut).toHaveBeenCalled();
  });

  it('deletes the account only after an explicit confirm click', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      { kind: 'dashboard', queries: [], feed: null, editing: null, reviewing: null, billing: null },
      handlers
    );

    const button = container.querySelector<HTMLButtonElement>('button[data-action=delete-account]')!;
    button.click();
    expect(handlers.onDeleteAccount).not.toHaveBeenCalled();
    expect(button.dataset.confirmed).toBe('true');

    button.click();
    expect(handlers.onDeleteAccount).toHaveBeenCalled();
  });

  it('renders an editing card prefilled and saves the edited values', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [query()],
        feed: null,
        editing: { queryId: 'q1', text: 'Auer Dult Munich', recurrenceInterval: 'quarterly', events: [] },
        reviewing: null,
        billing: null,
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
        queries: [query({ approvedCount: 1, candidateCount: 1 })],
        feed: null,
        editing: {
          queryId: 'q1',
          text: 'Auer Dult Munich',
          recurrenceInterval: 'quarterly',
          events: [
            { id: 'e1', label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-05-11', sourceUrl: 'u1', status: 'approved', decision: 'none' },
            { id: 'e2', label: 'Jakobidult', startDate: '2026-07-25', endDate: '2026-08-03', sourceUrl: 'u2', status: 'candidate', decision: 'approve' },
          ],
        },
        reviewing: null,
        billing: null,
      },
      handlers
    );

    expect(container.textContent).toContain('approved');
    const checkbox = container.querySelector<HTMLInputElement>('.edit-form .day-tile input[type=checkbox]')!;
    expect(checkbox.checked).toBe(true);
    checkbox.click();
    expect(handlers.onToggleEditEvent).toHaveBeenCalledWith('e2');
  });

  it('shows a distinct dismiss style and label when a candidate is decided for dismissal', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [query()],
        feed: null,
        editing: null, billing: null,
        reviewing: {
          queryId: 'q1',
          recurrenceInterval: 'weekly',
          events: [
            { id: 'e1', label: 'Oktoberfest', startDate: '2026-09-19', endDate: '2026-09-19', sourceUrl: 'u', status: 'candidate', decision: 'dismiss' },
          ],
        },
      },
      noopHandlers()
    );

    const tile = container.querySelector('.day-tile')!;
    expect(tile.classList.contains('day-tile-decision-dismiss')).toBe(true);
    expect(tile.classList.contains('day-tile-decision-approve')).toBe(false);
    expect(container.textContent).toContain('Dismissing');
  });

  it('counts only approve-decided tiles in the review approve button, not dismissed ones', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [query()],
        feed: null,
        editing: null, billing: null,
        reviewing: {
          queryId: 'q1',
          recurrenceInterval: 'weekly',
          events: [
            { id: 'e1', label: 'A', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'u', status: 'candidate', decision: 'approve' },
            { id: 'e2', label: 'B', startDate: '2026-01-02', endDate: '2026-01-02', sourceUrl: 'u', status: 'candidate', decision: 'dismiss' },
          ],
        },
      },
      noopHandlers()
    );

    const approveButton = container.querySelector<HTMLButtonElement>('button[data-action=approve-review]')!;
    expect(approveButton.textContent).toContain('1');
    expect(approveButton.textContent).not.toContain('2');
  });

  it('deleting a query requires a confirmation click before calling the handler', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      { kind: 'dashboard', queries: [query()], feed: null, editing: null, reviewing: null, billing: null },
      handlers
    );

    const deleteButton = container.querySelector<HTMLButtonElement>('.query-card button[data-action=delete]')!;
    deleteButton.click();
    expect(handlers.onDeleteQuery).not.toHaveBeenCalled();
    expect(deleteButton.textContent).toContain('Confirm');
    deleteButton.click();
    expect(handlers.onDeleteQuery).toHaveBeenCalledWith('q1');
  });

  it('renders the admin panel with stats, a user table and working actions', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    renderWorkspace(
      container,
      {
        kind: 'admin',
        stats: { totalUsers: 2, totalQueries: 3, approvedEvents: 1, candidateEvents: 0, activeUsers7d: 1 },
        users: [
          { id: 'u1', email: 'admin@example.com', role: 'admin', createdAt: null, queryCount: 0 },
          { id: 'u2', email: 'u@example.com', role: 'user', createdAt: null, queryCount: 3 },
        ],
        models: [
          {
            id: 'deepseek-v4-flash-free',
            providerId: 'opencode',
            role: 'default',
            enabled: true,
            calls: 10,
            failures: 1,
            successRate: 90,
            avgLatencyMs: 1200,
            maxLatencyMs: 3000,
          },
        ],
        search: {
          calls: 12,
          failures: 0,
          errorRate: 0,
          avgLatencyMs: 400,
          maxLatencyMs: 900,
          avgResultCount: 5,
          lastErrorAt: null,
        },
      },
      handlers
    );

    expect(container.textContent).toContain('Admin');
    expect(container.textContent).toContain('admin@example.com');
    expect(container.textContent).toContain('u@example.com');
    expect(container.querySelectorAll('.admin-stat')).toHaveLength(8);

    const rows = container.querySelectorAll<HTMLElement>('.admin-user-row');
    expect(rows).toHaveLength(3); // header + two users

    const deleteButton = rows[1].querySelector<HTMLButtonElement>('button[data-action=delete-user]')!;
    deleteButton.click();
    expect(handlers.onDeleteAdminUser).not.toHaveBeenCalled();
    expect(deleteButton.textContent).toContain('Confirm');
    deleteButton.click();
    expect(handlers.onDeleteAdminUser).toHaveBeenCalledWith('u1');

    container.querySelector<HTMLButtonElement>('button[data-action=close-admin]')!.click();
    expect(handlers.onCloseAdmin).toHaveBeenCalled();
  });

  it('shows a loading hint in the admin panel before stats land', () => {
    const container = document.createElement('div');
    renderWorkspace(
      container,
      { kind: 'admin', stats: null, users: [], models: [], search: null },
      noopHandlers()
    );

    expect(container.textContent).toContain('Loading');
    expect(container.querySelectorAll('.admin-stat')).toHaveLength(0);
  });

  it('renders an upgrade action for a free-tier user with remaining quota', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    const billing = { freeLimit: 1, activeQueryCount: 0, pricePerExtraQuery: 0.5, subscribed: false, subscriptionStatus: null, checkoutUrl: '/api/billing/checkout', portalUrl: '/api/billing/portal' };
    renderWorkspace(
      container,
      { kind: 'dashboard', queries: [query()], feed: null, editing: null, reviewing: null, billing },
      handlers
    );

    expect(container.textContent).toContain('1 free');
    expect(container.querySelector<HTMLButtonElement>('button[data-action=upgrade]')).not.toBeNull();
    container.querySelector<HTMLButtonElement>('button[data-action=upgrade]')!.click();
    expect(handlers.onUpgrade).toHaveBeenCalled();
  });

  it('renders a manage action for a subscribed user', () => {
    const container = document.createElement('div');
    const handlers = noopHandlers();
    const billing = { freeLimit: 1, activeQueryCount: 2, pricePerExtraQuery: 0.5, subscribed: true, subscriptionStatus: 'active', checkoutUrl: '/api/billing/checkout', portalUrl: '/api/billing/portal' };
    renderWorkspace(
      container,
      { kind: 'dashboard', queries: [query()], feed: null, editing: null, reviewing: null, billing },
      handlers
    );

    expect(container.textContent).toContain('Subscribed');
    expect(container.querySelector<HTMLButtonElement>('button[data-action=manage-billing]')).not.toBeNull();
    container.querySelector<HTMLButtonElement>('button[data-action=manage-billing]')!.click();
    expect(handlers.onManageBilling).toHaveBeenCalled();
  });
});