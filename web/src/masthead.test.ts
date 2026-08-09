import { describe, it, expect } from 'vitest';
import { formatDateline, renderMasthead } from './masthead';

describe('formatDateline', () => {
  it('formats a date as "Weekday, D Month YYYY"', () => {
    expect(formatDateline(new Date(2026, 7, 9))).toBe('Sunday, 9 August 2026');
  });

  it('does not zero-pad the day number', () => {
    expect(formatDateline(new Date(2026, 0, 5))).toBe('Monday, 5 January 2026');
  });
});

describe('renderMasthead', () => {
  it('renders the wordmark and the given date', () => {
    const masthead = renderMasthead(new Date(2026, 7, 9));
    expect(masthead.classList.contains('masthead')).toBe(true);
    expect(masthead.textContent).toContain('dontforget');
    expect(masthead.textContent).toContain('Sunday, 9 August 2026');
  });

  it('defaults to today when no date is passed', () => {
    const masthead = renderMasthead();
    expect(masthead.querySelector('.masthead-dateline')!.textContent).toMatch(/\d{4}$/);
  });
});
