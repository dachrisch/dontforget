import type { Db } from 'mongodb';

export async function migrate(db: Db): Promise<void> {
  // Event series for the two-stage pipeline (issue #143): one user query
  // fans out to a bounded set of reviewable series, and each approved
  // series expands into concrete dated events. Dismissed series are never
  // re-created — insertDiscoveredSeries dedupes on normalized_title across
  // all statuses, hence the unique compound index.
  await db.createCollection('series');
  await db.collection('series').createIndex({ query_id: 1 });
  await db.collection('series').createIndex({ user_id: 1 });
  await db.collection('series').createIndex({ query_id: 1, status: 1 });
  await db
    .collection('series')
    .createIndex({ query_id: 1, normalized_title: 1 }, { unique: true });

  // Concrete occurrences keep their query_id link (scheduler/dashboard
  // compatibility) and gain an optional series_id back-pointer. Existing
  // rows predate the field and simply omit it.
  await db.collection('events').createIndex({ series_id: 1 });
}
