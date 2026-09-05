import { ObjectId, type Db } from 'mongodb';
import { isReviewAction, type ReviewAction, type ReviewTokenRow } from './reviewTokens.js';

export type ReviewCallbackResult =
  | { ok: true; action: ReviewAction; eventLabel: string; queryText: string }
  | { ok: false; reason: 'invalid-action' | 'invalid-or-used' | 'not-found' | 'already-acted' };

// Applies a calendar review click. Converges on the same state changes as
// the in-app approval flow: approve flips the candidate to approved,
// dismiss flips it to dismissed, suppress deletes the originating query and
// all its events. The token is single-use — every path that resolves a live
// token marks it consumed, so the review entry (derived from still-
// candidate events) is not re-presented after any action.
export async function handleReviewCallback(
  db: Db,
  token: string,
  action: string
): Promise<ReviewCallbackResult> {
  if (!isReviewAction(action)) {
    return { ok: false, reason: 'invalid-action' };
  }

  const tokenRow = await db.collection<ReviewTokenRow>('review_tokens').findOneAndUpdate(
    { token, used_at: null, expires_at: { $gt: new Date() } },
    { $set: { used_at: new Date(), action } }
  );
  if (!tokenRow) {
    return { ok: false, reason: 'invalid-or-used' };
  }

  const query = await db.collection<{ _id: ObjectId; user_id: string; query_text: string }>(
    'queries'
  ).findOne({ _id: tokenRow.query_id });
  if (!query || query.user_id !== tokenRow.user_id) {
    return { ok: false, reason: 'not-found' };
  }

  if (action === 'suppress') {
    // "Not interested at all" unsubscribes the search: delete the query and
    // its events, like deleteQuery in queriesRepo.ts. No confirmation step —
    // the unguessable token already gates the action.
    await db.collection('queries').deleteOne({ _id: query._id });
    await db.collection('events').deleteMany({ query_id: query._id });
    // Retire sibling tokens for the deleted query so no dangling live token
    // survives for an event that no longer exists.
    await db
      .collection('review_tokens')
      .updateMany(
        { query_id: query._id, used_at: null },
        { $set: { used_at: new Date(), action: 'suppress' as ReviewAction } }
      );
    return { ok: true, action, eventLabel: '', queryText: query.query_text };
  }

  const event = await db
    .collection<{ _id: ObjectId; label: string; status: string }>('events')
    .findOne({ _id: tokenRow.event_id, query_id: query._id });
  if (!event) {
    return { ok: false, reason: 'not-found' };
  }
  if (event.status !== 'candidate') {
    return { ok: false, reason: 'already-acted' };
  }

  await db
    .collection('events')
    .updateOne(
      { _id: event._id, query_id: query._id },
      { $set: { status: action === 'approve' ? 'approved' : 'dismissed' } }
    );
  return { ok: true, action, eventLabel: event.label, queryText: query.query_text };
}

export function reviewConfirmationHtml(result: ReviewCallbackResult): string {
  const body = (() => {
    if (!result.ok) {
      const message =
        result.reason === 'invalid-action'
          ? 'Unknown action. Use one of the links from your calendar entry.'
          : result.reason === 'already-acted'
            ? 'This date was already reviewed — nothing left to do.'
            : result.reason === 'not-found'
              ? 'This search or date no longer exists — nothing left to do.'
              : 'This link is invalid, expired, or already used.';
      return `<p style="margin:0;font-size:15px;color:#555;line-height:1.5;">${message}</p>`;
    }
    if (result.action === 'approve') {
      return (
        `<p style="margin:0 0 8px;font-size:15px;color:#1a1a2e;line-height:1.5;"><b>Approved.</b> ` +
        `${escapeHtml(result.eventLabel)} is now in your calendar feed.</p>` +
        `<p style="margin:0;font-size:14px;color:#555;line-height:1.5;">Your subscribed calendar picks it up on its next refresh.</p>`
      );
    }
    if (result.action === 'dismiss') {
      return (
        `<p style="margin:0;font-size:15px;color:#1a1a2e;line-height:1.5;"><b>Dismissed.</b> ` +
        `You won't see ${escapeHtml(result.eventLabel)} again.</p>`
      );
    }
    return (
      `<p style="margin:0;font-size:15px;color:#1a1a2e;line-height:1.5;"><b>Unsubscribed.</b> ` +
      `Deleted the search &quot;${escapeHtml(result.queryText)}&quot; and its events.</p>`
    );
  })();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>dontforget review</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:40px 20px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
  <tr><td style="padding:32px 32px 16px;">
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#1a1a2e;">dontforget</h1>
  </td></tr>
  <tr><td style="padding:0 32px 32px;">
    ${body}
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
