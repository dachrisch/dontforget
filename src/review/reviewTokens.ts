import { randomBytes } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';

// Review tokens gate the calendar triage links. Same unguessable-token
// pattern as magic-link auth: one single-use token per candidate event,
// shared by its three action URLs (the `action` query param picks which one
// the click applies). The row's `action` field records which action the
// token was consumed with.
export const REVIEW_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type ReviewAction = 'approve' | 'dismiss' | 'suppress';

export const REVIEW_ACTIONS: ReviewAction[] = ['approve', 'dismiss', 'suppress'];

export function isReviewAction(value: unknown): value is ReviewAction {
  return typeof value === 'string' && (REVIEW_ACTIONS as string[]).includes(value);
}

export interface ReviewTokenRow {
  _id: ObjectId;
  token: string;
  event_id: ObjectId;
  query_id: ObjectId;
  user_id: string;
  expires_at: Date;
  used_at: Date | null;
  action: ReviewAction | null;
  created_at: Date;
}

// Returns the live token for a candidate event, minting one when none
// exists (or the old one expired / was consumed). The feed generator calls
// this per candidate on every poll, so links stay clickable while the event
// is still awaiting review.
export async function getOrCreateReviewToken(
  db: Db,
  eventId: ObjectId,
  queryId: ObjectId,
  userId: string
): Promise<string> {
  const now = new Date();
  const existing = await db.collection<ReviewTokenRow>('review_tokens').findOne({
    event_id: eventId,
    used_at: null,
    expires_at: { $gt: now },
  });
  if (existing) {
    return existing.token;
  }

  const token = randomBytes(32).toString('hex');
  await db.collection('review_tokens').insertOne({
    token,
    event_id: eventId,
    query_id: queryId,
    user_id: userId,
    expires_at: new Date(now.getTime() + REVIEW_TOKEN_TTL_MS),
    used_at: null,
    action: null,
    created_at: now,
  });
  return token;
}

export function buildReviewActionUrls(
  publicBaseUrl: string,
  token: string
): { approveUrl: string; dismissUrl: string; suppressUrl: string } {
  const base = `${publicBaseUrl}/api/review/callback?token=${token}`;
  return {
    approveUrl: `${base}&action=approve`,
    dismissUrl: `${base}&action=dismiss`,
    suppressUrl: `${base}&action=suppress`,
  };
}
