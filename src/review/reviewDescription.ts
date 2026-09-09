import { buildReviewActionUrls } from './reviewTokens.js';

export interface ReviewEntryContent {
  // Plain-text fallback for calendar clients that strip HTML (Outlook).
  // Carries the raw action URLs so triage still works without links.
  text: string;
  // Inline-styled HTML for clients that render descriptions as HTML
  // (Google Calendar, Apple Calendar): a styled info block plus real
  // button links. Kept to <p>/<b>/<a>/<br> with inline styles only —
  // calendar renderers sanitize aggressively (<style> blocks, classes, and
  // external CSS never survive), matching the magicLinkHtml pattern.
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const FONT_STACK = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

// A button that survives calendar HTML sanitizers: a plain link styled
// inline (no classes, no <style>). Primary is filled, secondary is an
// outline in the same hue; danger shifts both toward the brand accent.
function actionButton(url: string, label: string, kind: 'primary' | 'secondary' | 'danger' = 'secondary'): string {
  const base =
    `display:inline-block;text-decoration:none;font-family:${FONT_STACK};font-size:14px;font-weight:600;` +
    `line-height:1.2;padding:8px 16px;border-radius:8px;margin:2px 6px 2px 0;`;
  const style =
    kind === 'primary'
      ? `background-color:#1a1a2e;color:#ffffff;border:1px solid #1a1a2e;`
      : kind === 'danger'
        ? `background-color:transparent;color:#a4302a;border:1px solid #a4302a;`
        : `background-color:transparent;color:#2563eb;border:1px solid #2563eb;`;
  return `<a href="${url}" style="${base}${style}">${label}</a>`;
}

function infoBlock(lines: string[]): string {
  return (
    `<p style="font-family:${FONT_STACK};font-size:14px;color:#1a1a2e;line-height:1.6;">` +
    lines.join('<br>') +
    `</p>`
  );
}

function copyFallbackBlock(urls: string[]): string {
  return (
    `<p style="font-family:${FONT_STACK};font-size:12px;color:#888888;line-height:1.5;">` +
    `Buttons not working? Copy a link into your browser:<br>` +
    urls.join('<br>') +
    `</p>`
  );
}

function formatDateRange(startDate: string, endDate: string): string {
  return startDate === endDate ? startDate : `${startDate} to ${endDate}`;
}

export function buildReviewEntryContent(args: {
  publicBaseUrl: string;
  token: string;
  queryText: string;
  label: string;
  startDate: string;
  endDate: string;
  sourceUrl: string;
  // A candidate date of a subscribed series unsubscribes the series on
  // "not interested at all" (not the whole search) — name it when known.
  seriesTitle?: string | null;
}): ReviewEntryContent {
  const urls = buildReviewActionUrls(args.publicBaseUrl, args.token);
  const dateRange = formatDateRange(args.startDate, args.endDate);
  const unsubscribeLabel = args.seriesTitle
    ? `Unsubscribe from "${args.seriesTitle}"`
    : 'Not interested at all';

  const text =
    `New candidate date for "${args.queryText}": ${args.label} (${dateRange}).\n` +
    `Review it here instead of opening the app.\n\n` +
    `Source: ${args.sourceUrl}\n\n` +
    `Approve (add to your feed): ${urls.approveUrl}\n` +
    `Not interested this time (dismiss this date): ${urls.dismissUrl}\n` +
    `${unsubscribeLabel} (${args.seriesTitle ? 'removes its dates from your feed' : 'delete this search and its events'}): ${urls.suppressUrl}`;

  const safeLabel = escapeHtml(args.label);
  const safeQuery = escapeHtml(args.queryText);
  const safeRange = escapeHtml(dateRange);
  const safeSource = escapeHtml(args.sourceUrl);
  const safeSeries = args.seriesTitle ? escapeHtml(args.seriesTitle) : null;

  const html =
    infoBlock([
      `<b>${safeLabel}</b>`,
      `<span style="color:#555555;">${safeRange} · ${safeSeries ? `Series &quot;${safeSeries}&quot; · ` : ''}Search &quot;${safeQuery}&quot;</span>`,
      `Source: <a href="${safeSource}" style="color:#2563eb;">${safeSource}</a>`,
    ]) +
    `<p style="font-family:${FONT_STACK};font-size:14px;line-height:1.5;">` +
    actionButton(urls.approveUrl, '✓ Approve', 'primary') +
    actionButton(urls.dismissUrl, 'Not this time') +
    actionButton(urls.suppressUrl, safeSeries ? `Unsubscribe` : 'Not at all', 'danger') +
    `</p>` +
    copyFallbackBlock([urls.approveUrl, urls.dismissUrl, urls.suppressUrl]);

  return { text, html };
}

// One-off calendar entry title for a candidate. Distinct from the real event
// title so the review entry never looks like a confirmed date.
export function reviewEntryTitle(label: string): string {
  return `Review: ${label}`;
}

// Triage links for an already-approved date (typically an occurrence of a
// subscribed series): keeping it needs no action, so there is no approve
// link — only "dismiss this one date" and "unsubscribe one level above"
// (the series when the date belongs to one, else the whole search).
export function buildApprovedEntryContent(args: {
  publicBaseUrl: string;
  token: string;
  label: string;
  startDate: string;
  endDate: string;
  sourceUrl: string;
  seriesTitle: string | null;
}): ReviewEntryContent {
  const urls = buildReviewActionUrls(args.publicBaseUrl, args.token);
  const dateRange = formatDateRange(args.startDate, args.endDate);
  const unsubscribeLine = args.seriesTitle
    ? `Unsubscribe from the series "${args.seriesTitle}" (removes its dates from your feed): ${urls.suppressUrl}`
    : `Not interested at all (delete this search and its events): ${urls.suppressUrl}`;

  const text =
    `"${args.label}" (${dateRange}) is on your calendar via dontforget. Nothing to do to keep it.\n\n` +
    `Source: ${args.sourceUrl}\n\n` +
    `Not interested in this date: ${urls.dismissUrl}\n` +
    `${unsubscribeLine}`;

  const safeLabel = escapeHtml(args.label);
  const safeRange = escapeHtml(dateRange);
  const safeSource = escapeHtml(args.sourceUrl);
  const safeSeries = args.seriesTitle ? escapeHtml(args.seriesTitle) : null;

  const html =
    infoBlock([
      `<b>${safeLabel}</b>`,
      `<span style="color:#555555;">${safeRange}${safeSeries ? ` · Series &quot;${safeSeries}&quot;` : ''} · On your calendar ✓</span>`,
      `Source: <a href="${safeSource}" style="color:#2563eb;">${safeSource}</a>`,
    ]) +
    `<p style="font-family:${FONT_STACK};font-size:14px;line-height:1.5;">` +
    actionButton(urls.dismissUrl, 'Not this date') +
    actionButton(urls.suppressUrl, safeSeries ? 'Unsubscribe series' : 'Not at all', 'danger') +
    `</p>` +
    copyFallbackBlock([urls.dismissUrl, urls.suppressUrl]);

  return { text, html };
}
