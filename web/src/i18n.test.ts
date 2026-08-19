import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectLocale, getLocale, setLocale, t } from './i18n';
import { renderWorkspace, type WorkspaceHandlers } from './render';
import { formatDateline } from './masthead';

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
  };
}

afterEach(() => {
  setLocale('en');
});

describe('detectLocale', () => {
  it('picks German from a de-DE browser preference', () => {
    expect(detectLocale(['de-DE', 'en-US', 'en'])).toBe('de');
  });

  it('picks English from an en browser preference', () => {
    expect(detectLocale(['en-US', 'de'])).toBe('en');
  });

  it('falls back to English for unsupported locales', () => {
    expect(detectLocale(['fr-FR', 'it'])).toBe('en');
  });

  it('uses navigator.languages when no list is passed', () => {
    expect(detectLocale()).toBe('en');
  });
});

describe('t', () => {
  it('returns the English string by default', () => {
    expect(t('signIn.title')).toBe('Sign in');
  });

  it('returns the German string after switching locale', () => {
    setLocale('de');
    expect(t('signIn.title')).toBe('Anmelden');
  });

  it('interpolates variables', () => {
    setLocale('de');
    expect(t('review.approve', { count: 3 })).toBe('Auswahl bestätigen (3)');
  });
});

describe('German rendering', () => {
  it('renders the sign-in screen in German', () => {
    setLocale('de');
    const container = document.createElement('div');
    renderWorkspace(container, { kind: 'signedOut' }, noopHandlers());

    expect(container.textContent).toContain('Anmelden');
    expect(container.textContent).toContain('Kein Passwort');
    expect(document.documentElement.lang).toBe('de');
  });

  it('renders reviewing tiles with German month abbreviations and date order', () => {
    setLocale('de');
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [
          { id: 'q1', text: 'Auer Dult München', recurrenceInterval: 'quarterly', lastRunAt: null, createdAt: '2026-08-01T00:00:00Z', approvedCount: 0, candidateCount: 1, status: 'ready' },
        ],
        feed: null,
        editing: null,
        reviewing: {
          queryId: 'q1',
          recurrenceInterval: 'yearly',
          events: [
            {
              id: 'e1',
              label: 'Frühjahrsdult',
              startDate: '2026-03-15',
              endDate: '2026-03-22',
              sourceUrl: 'u',
              status: 'candidate',
              selected: true,
            },
          ],
        },
      },
      noopHandlers()
    );

    expect(container.textContent).toContain('MÄR');
    expect(container.textContent).toContain('15. MÄR 2026–22. MÄR 2026');
    expect(container.textContent).toContain('Auswahl bestätigen (1)');
  });

  it('renders the running query card in German', () => {
    setLocale('de');
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [
          { id: 'q1', text: 'Auer Dult München', recurrenceInterval: 'quarterly', lastRunAt: null, createdAt: '2026-08-01T00:00:00Z', approvedCount: 0, candidateCount: 0, status: 'running' },
        ],
        feed: null,
        editing: null,
        reviewing: null,
      },
      noopHandlers()
    );

    expect(container.textContent).toContain('Auer Dult München');
    expect(container.textContent).toMatch(/Suche/i);
    expect(container.querySelectorAll('.tick')).toHaveLength(3);
  });

  it('renders the failed query card in German with a retry action', () => {
    setLocale('de');
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [
          { id: 'q1', text: 'Auer Dult München', recurrenceInterval: 'quarterly', lastRunAt: null, createdAt: '2026-08-01T00:00:00Z', approvedCount: 0, candidateCount: 0, status: 'failed' },
        ],
        feed: null,
        editing: null,
        reviewing: null,
      },
      noopHandlers()
    );

    expect(container.textContent).toContain('fehlgeschlagen');
    expect(container.textContent).toContain('Erneut versuchen');
  });

  it('renders the dashboard with German labels', () => {
    setLocale('de');
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [
          { id: 'q1', text: 'Auer Dult München', recurrenceInterval: 'quarterly', lastRunAt: null, createdAt: '2026-08-01T00:00:00Z', approvedCount: 2, candidateCount: 1, status: 'ready' },
        ],
        feed: null,
        editing: null,
        reviewing: null,
      },
      noopHandlers()
    );

    expect(container.textContent).toContain('Auer Dult München');
    expect(container.textContent).toContain('Jedes Quartal');
    expect(container.textContent).toContain('2 bestätigt');
    expect(container.textContent).toContain('1 offen');
  });

  it('renders the "none yet" placeholder in German for a fresh query', () => {
    setLocale('de');
    const container = document.createElement('div');
    renderWorkspace(
      container,
      {
        kind: 'dashboard',
        queries: [
          { id: 'q1', text: 'Auer Dult München', recurrenceInterval: 'quarterly', lastRunAt: null, createdAt: '2026-08-01T00:00:00Z', approvedCount: 0, candidateCount: 0, status: 'ready' },
        ],
        feed: null,
        editing: null,
        reviewing: null,
      },
      noopHandlers()
    );

    expect(container.textContent).toContain('Noch keine');
  });

  it('formats the masthead dateline in German', () => {
    setLocale('de');
    expect(formatDateline(new Date(2026, 7, 9))).toBe('Sonntag, 9. August 2026');
  });

  it('switches back to English after setLocale("en")', () => {
    setLocale('de');
    expect(getLocale()).toBe('de');
    setLocale('en');
    const container = document.createElement('div');
    renderWorkspace(container, { kind: 'signedOut' }, noopHandlers());
    expect(container.textContent).toContain('Sign in');
  });
});