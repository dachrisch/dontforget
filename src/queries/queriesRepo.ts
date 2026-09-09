import { ObjectId, type Db } from 'mongodb';
import {
  DEFAULT_RECURRENCE_INTERVAL,
  type CandidateEvent,
  type Dashboard,
  type ExtractedEvent,
  type QueryStatus,
  type QuerySummary,
  type RecurrenceInterval,
  type SeriesSummary,
} from '../types.js';
import { filterNewEvents } from '../scheduler/dedupeEvents.js';
import { buildFeedUrls } from '../feed/feedUrl.js';
import { getOrCreateFeedToken } from '../feed/feedToken.js';
import type { SeriesRow } from './seriesRepo.js';

interface EventRow {
  _id: ObjectId;
  label: string;
  start_date: string;
  end_date: string;
  source_url: string;
  status: 'candidate' | 'approved' | 'dismissed';
  series_id?: ObjectId;
}

interface QueryRow {
  _id: ObjectId;
  user_id: string;
  query_text: string;
  recurrence_interval?: RecurrenceInterval;
  created_at: Date;
  last_run_at?: Date | null;
  status?: QueryStatus;
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
  recurrenceInterval: RecurrenceInterval = DEFAULT_RECURRENCE_INTERVAL
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
    status: 'running' as const,
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
//
// opts.seriesId links the inserted events to their parent series (issue
// #143); the query_id link is always retained for scheduler/dashboard
// compatibility.
export async function completeQueryRun(
  db: Db,
  queryId: ObjectId,
  events: ExtractedEvent[],
  cadence?: RecurrenceInterval | null,
  opts: { seriesId?: ObjectId } = {}
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
      ...(opts.seriesId ? { series_id: opts.seriesId } : {}),
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
        ...(doc.series_id ? { seriesId: doc.series_id.toString() } : {}),
      }))
    );

    // A fresh feed token means the user can subscribe before approving
    // anything — the candidate review entries show up in the feed alongside
    // any approved events from the very first run.
    const queryRow = await db
      .collection<{ _id: ObjectId; user_id: string }>('queries')
      .findOne({ _id: queryId }, { projection: { user_id: 1 } });
    if (queryRow) {
      await getOrCreateFeedToken(db, queryRow.user_id);
    }
  }

  const set: Record<string, unknown> = { status: 'ready' as const, last_run_at: now };
  if (cadence) set.recurrence_interval = cadence;
  await db.collection('queries').updateOne({ _id: queryId }, { $set: set });
  return inserted;
}

export async function markQueryFailed(db: Db, queryId: ObjectId): Promise<void> {
  await db.collection('queries').updateOne({ _id: queryId }, { $set: { status: 'failed' as const } });
}

// Marks a series-discovery run as landed without inserting dated events:
// flips the query from `running` to `ready` and stamps last_run_at. Series
// rows themselves are inserted by insertDiscoveredSeries before this call.
export async function completeSeriesDiscoveryRun(db: Db, queryId: ObjectId): Promise<void> {
  await db
    .collection('queries')
    .updateOne({ _id: queryId }, { $set: { status: 'ready' as const, last_run_at: new Date() } });
}

// Expands one subscribed series into concrete dated occurrences of what the
// series applies to (searxngSearch + extractSeriesDates + date-dedupe are
// run by the caller; this only lands the results). An approved series is
// trusted: new dates land as `approved` without per-event re-approval —
// the user subscribes to the series, not to its events individually. A
// non-approved series falls back to the query trust rule (approved only if
// the query already has an approved event).
// Events keep their query_id link and gain a series_id back-pointer.
// Dedupe is per-series (this series' dates plus legacy rows without any
// series), so two subscribed series sharing a calendar date both keep it.
export async function completeSeriesExpansion(
  db: Db,
  queryId: ObjectId,
  seriesId: ObjectId,
  events: ExtractedEvent[]
): Promise<CandidateEvent[]> {
  const existing = await db
    .collection<EventRow>('events')
    .find(
      {
        query_id: queryId,
        $or: [{ series_id: seriesId }, { series_id: { $exists: false } }],
      },
      { projection: { _id: 0, start_date: 1, end_date: 1, status: 1 } }
    )
    .toArray();
  const newEvents = filterNewEvents(events, existing);
  if (newEvents.length === 0) return [];

  const series = await db.collection<SeriesRow>('series').findOne({ _id: seriesId, query_id: queryId });
  const isTrusted = series?.status === 'approved' || existing.some(e => e.status === 'approved');
  const status = isTrusted ? 'approved' : 'candidate';
  const now = new Date();
  const docs = newEvents.map(event => ({
    _id: new ObjectId(),
    query_id: queryId,
    series_id: seriesId,
    label: event.label,
    start_date: event.startDate,
    end_date: event.endDate,
    source_url: event.sourceUrl,
    status,
    created_at: now,
  }));
  await db.collection('events').insertMany(docs);

  const queryRow = await db
    .collection<{ _id: ObjectId; user_id: string }>('queries')
    .findOne({ _id: queryId }, { projection: { user_id: 1 } });
  if (queryRow) {
    await getOrCreateFeedToken(db, queryRow.user_id);
  }

  return docs.map(doc => ({
    id: doc._id.toString(),
    label: doc.label,
    startDate: doc.start_date,
    endDate: doc.end_date,
    sourceUrl: doc.source_url,
    status: doc.status as 'candidate' | 'approved',
    seriesId: seriesId.toString(),
  }));
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
  const seriesByQuery = await seriesSummariesByQuery(db, queryRows.map(r => r._id));

  const queries: QuerySummary[] = queryRows.map(row => ({
    id: row._id.toString(),
    text: row.query_text,
    recurrenceInterval: row.recurrence_interval ?? DEFAULT_RECURRENCE_INTERVAL,
    lastRunAt: row.last_run_at ? row.last_run_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    approvedCount: counts.get(row._id.toString())?.approved ?? 0,
    candidateCount: counts.get(row._id.toString())?.candidate ?? 0,
    status: row.status ?? 'ready',
    series: seriesByQuery.get(row._id.toString()) ?? [],
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
  const seriesByQuery = await seriesSummariesByQuery(db, [result._id]);
  return {
    id: result._id.toString(),
    text: result.query_text,
    recurrenceInterval: result.recurrence_interval ?? DEFAULT_RECURRENCE_INTERVAL,
    lastRunAt: result.last_run_at ? result.last_run_at.toISOString() : null,
    createdAt: result.created_at.toISOString(),
    approvedCount: rowCounts.approved,
    candidateCount: rowCounts.candidate,
    status: result.status ?? 'ready',
    series: seriesByQuery.get(result._id.toString()) ?? [],
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
    ...buildFeedUrls(publicBaseUrl, tokenRow.token),
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

// Series counts nested under their parent query (issue #143): one
// SeriesSummary per series row with its dated event counts.
async function seriesSummariesByQuery(
  db: Db,
  queryIds: ObjectId[]
): Promise<Map<string, SeriesSummary[]>> {
  const byQuery = new Map<string, SeriesSummary[]>();
  if (queryIds.length === 0) return byQuery;
  for (const id of queryIds) byQuery.set(id.toString(), []);

  const seriesRows = await db
    .collection<SeriesRow>('series')
    .find({ query_id: { $in: queryIds } })
    .sort({ created_at: 1 })
    .toArray();
  if (seriesRows.length === 0) return byQuery;

  const seriesIds = seriesRows.map(r => r._id);
  const eventRows = await db
    .collection<{ series_id?: ObjectId; status: string }>('events')
    .aggregate<{ _id: { series_id: ObjectId; status: string }; count: number }>([
      { $match: { series_id: { $in: seriesIds } } },
      { $group: { _id: { series_id: '$series_id', status: '$status' }, count: { $sum: 1 } } },
    ])
    .toArray();
  const eventCounts = new Map<string, { approved: number; candidate: number }>();
  for (const row of eventRows) {
    const key = row._id.series_id.toString();
    const entry = eventCounts.get(key) ?? { approved: 0, candidate: 0 };
    if (row._id.status === 'approved') entry.approved = row.count;
    if (row._id.status === 'candidate') entry.candidate = row.count;
    eventCounts.set(key, entry);
  }

  for (const row of seriesRows) {
    const counts = eventCounts.get(row._id.toString()) ?? { approved: 0, candidate: 0 };
    byQuery.get(row.query_id.toString())?.push({
      id: row._id.toString(),
      title: row.title,
      appliesTo: row.applies_to ?? row.title,
      description: row.description,
      searchKeywords: row.search_keywords,
      sourceUrls: row.source_urls,
      status: row.status,
      eventCounts: counts,
    });
  }
  return byQuery;
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
    ...(row.series_id ? { seriesId: row.series_id.toString() } : {}),
  }));
}

export async function deleteQuery(db: Db, userId: string, queryId: string): Promise<boolean> {
  const queryObjectId = toObjectId(queryId);
  if (!queryObjectId) {
    return false;
  }

  const result = await db.collection('queries').deleteOne({ _id: queryObjectId, user_id: userId });
  if (result.deletedCount === 0) {
    return false;
  }
  await db.collection('events').deleteMany({ query_id: queryObjectId });
  await db.collection('series').deleteMany({ query_id: queryObjectId });
  return true;
}

function toObjectId(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}