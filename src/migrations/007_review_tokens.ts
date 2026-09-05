import type { Db } from 'mongodb';

export async function migrate(db: Db): Promise<void> {
  // One single-use token per candidate event, following the same
  // unguessable-token pattern as magic-link auth. The feed generator mints
  // a token per candidate and embeds approve/dismiss/suppress callback URLs
  // in the review entry's description; the callback route validates the
  // token, applies the action, and marks it used so the link cannot be
  // replayed.
  await db.createCollection('review_tokens');
  await db.collection('review_tokens').createIndex({ token: 1 }, { unique: true });
  await db.collection('review_tokens').createIndex({ event_id: 1 });
  await db.collection('review_tokens').createIndex({ query_id: 1 });
  await db.collection('review_tokens').createIndex({ expires_at: 1 });
}
