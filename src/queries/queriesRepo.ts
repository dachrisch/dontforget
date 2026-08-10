import { ObjectId, type Db } from 'mongodb';
import {
  DEFAULT_RECURRENCE_INTERVAL,
  type CandidateEvent,
  type Dashboard,
  type ExtractedEvent,
  type QuerySummary,
  type RecurrenceInterval,
} from '../types.js';

interface QueryRow {
  _id: ObjectId;
  user_id: string;
  query_text: string;
  recurrence_interval?: RecurrenceInterval;
  created_at: Date;
  last_run_at?: Date | null;
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

export async function createQueryWithCandidates(
  db: Db,
  userId: string,
  queryText: string,
  events: ExtractedEvent[],
  recurrenceInterval: RecurrenceInterval = DEFAULT_RECURRENCE_INTERVAL
): Promise<{ queryId: string; candidates: CandidateEvent[] }> {
  const now = new Date();
  const queryResult = await db.collection('queries').insertOne({
    user_id: userId,
    query_text: queryText,
    recurrence_interval: recurrenceInterval,
    created_at: now,
    // The synchronous first run just happened — the scheduler (future pass)
    // will bump this on every re-run.
    last_run_at: now,
  });
  const queryId = queryResult.insertedId.toString();

  if (events.length === 0) {
    return { queryId, candidates: [] };
  }

  const docs = events.map(event => ({
    _id: new ObjectId(),
    query_id: queryResult.insertedId,
    label: event.label,
    start_date: event.startDate,
    end_date: event.endDate,
    source_url: event.sourceUrl,
    status: 'candidate' as const,
    created_at: now,
  }));
  await db.collection('events').insertMany(docs);

  const candidates: CandidateEvent[] = docs.map((doc, i) => ({
    ...events[i],
    id: doc._id.toString(),
    status: 'candidate',
  }));

  return { queryId, candidates };
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

function toObjectId(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}