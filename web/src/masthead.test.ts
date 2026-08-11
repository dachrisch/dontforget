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
    expect(masthead.textContent).toContain('Sunday, 9 August 2026');
  });

  it('starts the animated wordmark on "forget" with a stem and sizer', () => {
    const masthead = renderMasthead();
    const stem = masthead.querySelector('.wordmark-stem');
    const sizer = masthead.querySelector('.wordmark-sizer');
    expect(stem?.textContent).toBe("don't");
    expect(sizer?.textContent).toBe('forget');
  });

  it('includes the "you\'re covered." tagline', () => {
    const masthead = renderMasthead();
    const tagline = masthead.querySelector('.wordmark-tagline');
    expect(tagline?.textContent).toBe(" — you're covered.");
    expect(tagline?.classList.contains('is-in')).toBe(false);
  });

  it('defaults to today when no date is passed', () => {
    const masthead = renderMasthead();
    expect(masthead.querySelector('.masthead-dateline')!.textContent).toMatch(/\d{4}$/);
  });
});
