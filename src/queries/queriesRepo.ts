import { ObjectId, type Db } from 'mongodb';
import {
  DEFAULT_RECURRENCE_INTERVAL,
  type CandidateEvent,
  type Dashboard,
  type ExtractedEvent,
  type QueryStatus,
  type QuerySummary,
  type RecurrenceInterval,
} from '../types.js';
import { filterNewEvents } from '../scheduler/dedupeEvents.js';

interface EventRow {
  _id: ObjectId;
  label: string;
  start_date: string;
  end_date: string;
  source_url: string;
  status: 'candidate' | 'approved' | 'dismissed';
}

interface QueryRow {
  _id: ObjectId;
  user_id: string;
  query_text: string;
  recurrence_interval?: RecurrenceInterval;
  created_at: Date;
  last_run_at?: Date | null;
  status?: QueryStatus;
  active?: boolean;
}

// The shape `runInitialQuery` needs to kick off a background search for a
// freshly created query.
export interface NewQuery {
  _id: ObjectId;
  queryId: string;
  user_id: string;
  query_text: string;
}

interface FeedTokenRow {
  token: string;
  user_id: string;
  last_fetched_at?: Date | null;
}

interface EventCounts {
  approved: number;
  candidate: number;
}

export async function createQuery(
  db: Db,
  userId: string,
  queryText: string,
  recurrenceInterval: RecurrenceInterval = DEFAULT_RECURRENCE_INTERVAL,
  active: boolean = true
): Promise<NewQuery> {
  const now = new Date();
  const queryResult = await db.collection('queries').insertOne({
    user_id: userId,
    query_text: queryText,
    recurrence_interval: recurrenceInterval,
    created_at: now,
    // Stamped at creation so the scheduler's due-check has something to work
    // with even if the background search dies mid-run; completeQueryRun bumps
    // it once the run actually lands.
    last_run_at: now,
    status: active ? ('running' as const) : ('blocked' as const),
    active,
  });
  return {
    _id: queryResult.insertedId,
    queryId: queryResult.insertedId.toString(),
    user_id: userId,
    query_text: queryText,
  };
}

// Lands a finished search on a query: inserts the not-yet-seen events
// (candidate unless the query is already trusted, mirroring scheduledRun's
// auto-approve rule), applies the AI-suggested cadence when the user did not
// pick one explicitly, and flips the query from `running` to `ready`.
// Returns the newly inserted events in their input order, so callers (and
// test helpers) can hand the ids straight back to an approval flow.
export async function completeQueryRun(
  db: Db,
  queryId: ObjectId,
  events: ExtractedEvent[],
  cadence?: RecurrenceInterval | null
): Promise<CandidateEvent[]> {
  const now = new Date();
  const existing = await db
    .collection<EventRow>('events')
    .find({ query_id: queryId }, { projection: { _id: 0, start_date: 1, end_date: 1, status: 1 } })
    .toArray();

  const newEvents = filterNewEvents(events, existing);
  const isTrusted = existing.some(e => e.status === 'approved');
  const status = isTrusted ? 'approved' : 'candidate';
  const inserted: CandidateEvent[] = [];
  if (newEvents.length > 0) {
    const docs = newEvents.map(event => ({
      _id: new ObjectId(),
      query_id: queryId,
      label: event.label,
      start_date: event.startDate,
      end_date: event.endDate,
      source_url: event.sourceUrl,
      status,
      created_at: now,
    }));
    await db.collection('events').insertMany(docs);
    inserted.push(
      ...docs.map(doc => ({
        id: doc._id.toString(),
        label: doc.label,
        startDate: doc.start_date,
        endDate: doc.end_date,
        sourceUrl: doc.source_url,
        status: doc.status as 'candidate' | 'approved',
      }))
    );
  }

  const set: Record<string, unknown> = { status: 'ready' as const, last_run_at: now };
  if (cadence) set.recurrence_interval = cadence;
  await db.collection('queries').updateOne({ _id: queryId }, { $set: set });
  return inserted;
}

export async function markQueryFailed(db: Db, queryId: ObjectId): Promise<void> {
  await db.collection('queries').updateOne({ _id: queryId }, { $set: { status: 'failed' as const } });
}

// Single-document atomicity: prevents the SAME query being claimed twice by
// a rapid double-click on retry/reactivate. Two DIFFERENT blocked/paused
// queries racing for the last free slot can each pass an earlier
// hasFreeSlot() check and both land here — this Mongo deployment is a
// standalone instance without a replica set, so multi-document transactions
// aren't available to close that window. Accepted: it's a soft billing
// quota, not a security boundary, and self-corrects on the next status
// fetch. See docs/superpowers/specs/2026-08-20-query-credits-design.md.
export async function claimSlotForQuery(db: Db, userId: string, queryId: ObjectId): Promise<boolean> {
  const result = await db.collection('queries').findOneAndUpdate(
    { _id: queryId, user_id: userId, active: { $ne: true } },
    { $set: { active: true } }
  );
  return result !== null;
}

export async function listQueriesForUser(
  db: Db,
  userId: string,
  publicBaseUrl: string
): Promise<Dashboard> {
  const queryRows = await db
    .collection<QueryRow>('queries')
    .find({ user_id: userId })
    .sort({ created_at: -1 })
    .toArray();

  const counts = await eventCountsByQuery(db, queryRows.map(r => r._id));

  const queries: QuerySummary[] = queryRows.map(row => ({
    id: row._id.toString(),
    text: row.query_text,
    recurrenceInterval: row.recurrence_interval ?? DEFAULT_RECURRENCE_INTERVAL,
    lastRunAt: row.last_run_at ? row.last_run_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    approvedCount: counts.get(row._id.toString())?.approved ?? 0,
    candidateCount: counts.get(row._id.toString())?.candidate ?? 0,
    status: row.status ?? 'ready',
    active: row.active ?? true,
  }));

  const feed = await feedSummary(db, userId, publicBaseUrl);

  return { queries, feed };
}

export async function updateQuery(
  db: Db,
  userId: string,
  queryId: string,
  patch: { text?: string; recurrenceInterval?: RecurrenceInterval }
): Promise<QuerySummary | null> {
  const queryObjectId = toObjectId(queryId);
  if (!queryObjectId) {
    return null;
  }

  const setFields: Record<string, unknown> = {};
  if (patch.text !== undefined) setFields.query_text = patch.text.trim();
  if (patch.recurrenceInterval !== undefined) {
    setFields.recurrence_interval = patch.recurrenceInterval;
  }
  if (Object.keys(setFields).length === 0) {
    return null;
  }

  const result = await db.collection<QueryRow>('queries').findOneAndUpdate(
    { _id: queryObjectId, user_id: userId },
    { $set: setFields },
    { returnDocument: 'after' }
  );
  if (!result) {
    return null;
  }

  const counts = await eventCountsByQuery(db, [result._id]);
  const rowCounts = counts.get(result._id.toString()) ?? { approved: 0, candidate: 0 };
  return {
    id: result._id.toString(),
    text: result.query_text,
    recurrenceInterval: result.recurrence_interval ?? DEFAULT_RECURRENCE_INTERVAL,
    lastRunAt: result.last_run_at ? result.last_run_at.toISOString() : null,
    createdAt: result.created_at.toISOString(),
    approvedCount: rowCounts.approved,
    candidateCount: rowCounts.candidate,
    status: result.status ?? 'ready',
    active: result.active ?? true,
  };
}

export async function feedSummary(
  db: Db,
  userId: string,
  publicBaseUrl: string
): Promise<Dashboard['feed']> {
  const tokenRow = await db.collection<FeedTokenRow>('feed_tokens').findOne({ user_id: userId });
  if (!tokenRow) {
    return null;
  }
  return {
    icsUrl: `${publicBaseUrl}/f/${tokenRow.token}.ics`,
    rssUrl: `${publicBaseUrl}/f/${tokenRow.token}.rss`,
    lastFetchedAt: tokenRow.last_fetched_at ? tokenRow.last_fetched_at.toISOString() : null,
  };
}

async function eventCountsByQuery(
  db: Db,
  queryIds: ObjectId[]
): Promise<Map<string, EventCounts>> {
  const counts = new Map<string, EventCounts>();
  if (queryIds.length === 0) {
    return counts;
  }

  const rows = await db
    .collection('events')
    .aggregate<{ _id: { query_id: ObjectId; status: string }; count: number }>([
      { $match: { query_id: { $in: queryIds } } },
      { $group: { _id: { query_id: '$query_id', status: '$status' }, count: { $sum: 1 } } },
    ])
    .toArray();

  for (const row of rows) {
    const key = row._id.query_id.toString();
    const entry = counts.get(key) ?? { approved: 0, candidate: 0 };
    if (row._id.status === 'approved') entry.approved = row.count;
    if (row._id.status === 'candidate') entry.candidate = row.count;
    counts.set(key, entry);
  }
  return counts;
}

export async function getQueryEvents(
  db: Db,
  userId: string,
  queryId: string
): Promise<CandidateEvent[] | null> {
  const queryObjectId = toObjectId(queryId);
  if (!queryObjectId) {
    return null;
  }

  const query = await db.collection<QueryRow>('queries').findOne({
    _id: queryObjectId,
    user_id: userId,
  });
  if (!query) {
    return null;
  }

  const rows = await db
    .collection<EventRow>('events')
    .find({ query_id: queryObjectId })
    .sort({ start_date: 1 })
    .toArray();

  return rows.map(row => ({
    id: row._id.toString(),
    label: row.label,
    startDate: row.start_date,
    endDate: row.end_date,
    sourceUrl: row.source_url,
    status: row.status,
  }));
}

// The shape the DELETE route needs to decide whether the deleted query held
// a purchased slot — a blocked or already-paused query never did, so
// deleting one must not release a slot (see `active`'s "absent means
// active" convention: a legacy row missing the field counts as active).
export interface DeletedQuery {
  active: boolean;
}

export async function deleteQuery(db: Db, userId: string, queryId: string): Promise<DeletedQuery | null> {
  const queryObjectId = toObjectId(queryId);
  if (!queryObjectId) {
    return null;
  }

  // findOneAndDelete atomically reads the row's `active` flag as it deletes
  // it, avoiding a second round-trip (and a race where the row's active
  // state changes between a separate read and delete).
  const deleted = await db
    .collection<QueryRow>('queries')
    .findOneAndDelete({ _id: queryObjectId, user_id: userId });
  if (!deleted) {
    return null;
  }
  await db.collection('events').deleteMany({ query_id: queryObjectId });
  return { active: deleted.active !== false };
}

function toObjectId(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}