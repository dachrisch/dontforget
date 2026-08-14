import type { Db } from 'mongodb';

export async function migrate(db: Db): Promise<void> {
  // The scheduler dedups a query's re-run results against everything
  // already stored for it (any status) by (label, start_date, end_date) —
  // this index makes that lookup an index scan instead of a full scan of
  // the query's events as event volume grows.
  await db.collection('events').createIndex({ query_id: 1, label: 1, start_date: 1, end_date: 1 });
}
