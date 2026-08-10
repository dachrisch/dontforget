import type { Db } from 'mongodb';

export async function migrate(db: Db): Promise<void> {
  // Dashboard listing sorts a user's queries newest-first; the feed and the
  // candidate/approved counts look events up by query + status.
  await db.collection('queries').createIndex({ user_id: 1, created_at: -1 });
  await db.collection('events').createIndex({ query_id: 1, status: 1 });
}