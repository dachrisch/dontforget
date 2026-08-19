import { ObjectId, type Db } from 'mongodb';

// Deletes every row that belongs to a user: the account itself, its
// sessions, unused magic links, its queries (and the events extracted for
// them), and the calendar feed token. Idempotent — a retry after a partial
// failure simply finds the already-deleted rows gone.
export async function deleteAccount(db: Db, userId: string): Promise<void> {
  const queryIds = await db
    .collection('queries')
    .find({ user_id: userId }, { projection: { _id: 1 } })
    .toArray();
  if (queryIds.length > 0) {
    await db
      .collection('events')
      .deleteMany({ query_id: { $in: queryIds.map(row => row._id) } });
  }
  await db.collection('queries').deleteMany({ user_id: userId });
  await db.collection('feed_tokens').deleteMany({ user_id: userId });
  await db.collection('magic_links').deleteMany({ user_id: userId });
  await db.collection('sessions').deleteMany({ user_id: userId });
  await db.collection('users').deleteOne({ _id: new ObjectId(userId) });
}