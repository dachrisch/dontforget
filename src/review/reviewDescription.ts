import { buildReviewActionUrls } from './reviewTokens.js';

export interface ReviewEntryContent {
  // Plain-text fallback for calendar clients that strip HTML (Outlook).
  // Carries the raw action URLs so triage still works without links.
  text: string;
  // Minimal inline-styled HTML for clients that render <a> tags in
  // descriptions (Google Calendar, Apple Calendar). Kept to <p>/<a>/<br>
  // with inline styles, matching the magicLinkHtml pattern.
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildReviewEntryContent(args: {
  publicBaseUrl: string;
  token: string;
  queryText: string;
  label: string;
  startDate: string;
  endDate: string;
  sourceUrl: string;
}): ReviewEntryContent {
  const urls = buildReviewActionUrls(args.publicBaseUrl, args.token);
  const dateRange =
    args.startDate === args.endDate ? args.startDate : `${args.startDate} to ${args.endDate}`;

  const text =
    `New candidate date for "${args.queryText}": ${args.label} (${dateRange}).\n` +
    `Review it here instead of opening the app.\n\n` +
    `Source: ${args.sourceUrl}\n\n` +
    `Approve (add to your feed): ${urls.approveUrl}\n` +
    `Not interested this time (dismiss this date): ${urls.dismissUrl}\n` +
    `Not interested at all (delete this search and its events): ${urls.suppressUrl}`;

  const safeLabel = escapeHtml(args.label);
  const safeQuery = escapeHtml(args.queryText);
  const safeRange = escapeHtml(dateRange);
  const safeSource = escapeHtml(args.sourceUrl);

  const html =
    `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1a1a2e;line-height:1.5;">` +
    `New candidate date for &quot;${safeQuery}&quot;: <b>${safeLabel}</b> (${safeRange}). ` +
    `Review it here instead of opening the app.</p>` +
    `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;">` +
    `<a href="${urls.approveUrl}" style="color:#2563eb;font-weight:600;">Approve</a> — add this date to your feed.<br>` +
    `<a href="${urls.dismissUrl}" style="color:#2563eb;">Not interested this time</a> — dismiss this date.<br>` +
    `<a href="${urls.suppressUrl}" style="color:#2563eb;">Not interested at all</a> — delete this search and its events.</p>` +
    `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#555;line-height:1.5;">` +
    `Source: <a href="${safeSource}" style="color:#2563eb;">${safeSource}</a></p>` +
    `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#888;line-height:1.5;">` +
    `Links not clickable? Copy one into your browser:<br>` +
    `${urls.approveUrl}<br>${urls.dismissUrl}<br>${urls.suppressUrl}</p>`;

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
  seriesTitle: string | null;
}): ReviewEntryContent {
  const urls = buildReviewActionUrls(args.publicBaseUrl, args.token);
  const unsubscribeLine = args.seriesTitle
    ? `Unsubscribe from the series "${args.seriesTitle}" (removes its dates from your feed): ${urls.suppressUrl}`
    : `Not interested at all (delete this search and its events): ${urls.suppressUrl}`;

  const text =
    `"${args.label}" is on your calendar via dontforget. Nothing to do to keep it.\n\n` +
    `Not interested in this date: ${urls.dismissUrl}\n` +
    `${unsubscribeLine}`;

  const safeLabel = escapeHtml(args.label);
  const safeUnsubscribe = args.seriesTitle
    ? `Unsubscribe from the series &quot;${escapeHtml(args.seriesTitle)}&quot;`
    : `Not interested at all`;

  const html =
    `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1a1a2e;line-height:1.5;">` +
    `&quot;${safeLabel}&quot; is on your calendar via dontforget. Nothing to do to keep it.</p>` +
    `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;">` +
    `<a href="${urls.dismissUrl}" style="color:#2563eb;">Not interested in this date</a> — remove just this one.<br>` +
    `<a href="${urls.suppressUrl}" style="color:#2563eb;">${safeUnsubscribe}</a> — ${
      args.seriesTitle ? 'remove all its dates from your feed.' : 'delete this search and its events.'
    }</p>` +
    `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#888;line-height:1.5;">` +
    `Links not clickable? Copy one into your browser:<br>` +
    `${urls.dismissUrl}<br>${urls.suppressUrl}</p>`;

  return { text, html };
}
