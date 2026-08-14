import type { Db } from 'mongodb';

export async function migrate(db: Db): Promise<void> {
  // Covering index for the scheduler's dedup read (scheduledRun.ts): the
  // query filters on query_id alone, and status/label/start_date/end_date
  // are exactly the fields it projects out (status decides trust; the rest
  // form the dedup key) — so this index can satisfy the read entirely from
  // the index itself, without touching the collection.
  await db.collection('events').createIndex({ query_id: 1, status: 1, label: 1, start_date: 1, end_date: 1 });
}
