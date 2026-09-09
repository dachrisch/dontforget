import { ObjectId, type Db } from 'mongodb';
import type { CandidateSeries, ExtractedSeries, SeriesStatus } from '../types.js';
import { MAX_SERIES, seriesIdentityKey } from '../search/opencodeClient.js';

export interface SeriesRow {
  _id: ObjectId;
  query_id: ObjectId;
  user_id: string;
  title: string;
  // Canonical recurring entity the series applies to (e.g. "Auer Dult,
  // Munich"). Rows written before migration 009 backfill it from title.
  applies_to: string;
  normalized_title: string;
  description: string;
  search_keywords: string;
  source_urls: string[];
  status: SeriesStatus;
  created_at: Date;
}

// Identity dedupe key: what the series applies to (falling back to title
// for pre-009 rows). Dismissed series are never re-created on re-run, and
// repeated discoveries of the same entity collapse to one row.
export function normalizeSeriesTitle(title: string): string {
  return seriesIdentityKey({ title });
}

function seriesIdentityOf(entry: { title: string; appliesTo?: string }): string {
  return seriesIdentityKey(entry);
}

function toCandidateSeries(row: SeriesRow): CandidateSeries {
  return {
    id: row._id.toString(),
    title: row.title,
    appliesTo: row.applies_to ?? row.title,
    description: row.description,
    searchKeywords: row.search_keywords,
    sourceUrls: row.source_urls,
    status: row.status,
  };
}

function toObjectId(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

// Inserts newly discovered series as `candidate` rows. Dedupe is by
// normalized title against ALL existing rows for the query — including
// `dismissed` ones, so a dismissed series is never re-created on re-run.
// Returns the newly inserted series in discovery order. Deterministically
// capped at MAX_SERIES (first N win) as a second line of defense behind the
// orchestrator/LLM cap.
export async function insertDiscoveredSeries(
  db: Db,
  queryId: ObjectId,
  userId: string,
  series: ExtractedSeries[]
): Promise<CandidateSeries[]> {
  const existing = await db
    .collection<SeriesRow>('series')
    .find({ query_id: queryId }, { projection: { normalized_title: 1, applies_to: 1, title: 1 } })
    .toArray();
  // Index both the stored normalized key and the identity recomputed from
  // applies_to: pre-009 rows normalized their bare title, while new
  // discoveries key on what the series applies to ("Auer Dult" vs
  // "Auer Dult, Munich" must still collide).
  const seen = new Set<string>();
  for (const row of existing) {
    if (row.normalized_title) seen.add(row.normalized_title);
    const identity = seriesIdentityKey({ title: row.title, appliesTo: row.applies_to });
    if (identity) seen.add(identity);
  }

  const now = new Date();
  const docs: SeriesRow[] = [];
  for (const entry of series) {
    const title = entry.title.trim();
    const appliesTo = (entry.appliesTo ?? '').trim() || title;
    const searchKeywords = entry.searchKeywords.trim();
    const sourceUrls = entry.sourceUrls.map(u => u.trim()).filter(u => u.length > 0);
    if (!title || !appliesTo || !searchKeywords || sourceUrls.length === 0) continue;
    const key = seriesIdentityOf({ title, appliesTo });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    docs.push({
      _id: new ObjectId(),
      query_id: queryId,
      user_id: userId,
      title,
      applies_to: appliesTo,
      normalized_title: key,
      description: entry.description.trim(),
      search_keywords: searchKeywords,
      source_urls: sourceUrls,
      status: 'candidate',
      created_at: now,
    });
    if (docs.length >= MAX_SERIES) break;
  }

  if (docs.length === 0) return [];
  await db.collection('series').insertMany(docs);
  return docs.map(toCandidateSeries);
}

export async function listSeriesForQuery(
  db: Db,
  userId: string,
  queryId: string
): Promise<CandidateSeries[] | null> {
  const queryObjectId = toObjectId(queryId);
  if (!queryObjectId) return null;
  const query = await db.collection('queries').findOne({ _id: queryObjectId, user_id: userId });
  if (!query) return null;
  const rows = await db
    .collection<SeriesRow>('series')
    .find({ query_id: queryObjectId })
    .sort({ created_at: 1 })
    .toArray();
  return rows.map(toCandidateSeries);
}

export async function getSeriesById(
  db: Db,
  userId: string,
  queryId: ObjectId,
  seriesId: string
): Promise<SeriesRow | null> {
  const seriesObjectId = toObjectId(seriesId);
  if (!seriesObjectId) return null;
  const row = await db.collection<SeriesRow>('series').findOne({ _id: seriesObjectId, query_id: queryId });
  if (!row || row.user_id !== userId) return null;
  return row;
}

export async function getApprovedSeriesForQuery(db: Db, queryId: ObjectId): Promise<SeriesRow[]> {
  return db.collection<SeriesRow>('series').find({ query_id: queryId, status: 'approved' }).toArray();
}

// Approves/dismisses series for a query the user owns. Dismiss wins on
// overlap (same contract as approveEvents). Returns null when the query
// doesn't belong to the user.
//
// Subscription semantics: the user subscribes to a series, not to its
// events individually. Approving a series subscribes to all its dates, so
// its existing candidate events flip to approved alongside it; dismissing
// unsubscribes, so its events (candidate or approved) flip to dismissed and
// can never leak into the feed.
export async function reviewSeries(
  db: Db,
  userId: string,
  queryId: string,
  approveIds: string[],
  dismissIds: string[] = []
): Promise<CandidateSeries[] | null> {
  const queryObjectId = toObjectId(queryId);
  if (!queryObjectId) return null;
  const query = await db.collection('queries').findOne({ _id: queryObjectId, user_id: userId });
  if (!query) return null;

  await setSeriesStatus(db, queryObjectId, approveIds, 'approved');
  await setSeriesStatus(db, queryObjectId, dismissIds, 'dismissed');
  await cascadeSeriesReviewToEvents(db, queryObjectId, approveIds, dismissIds);

  const rows = await db
    .collection<SeriesRow>('series')
    .find({ query_id: queryObjectId })
    .sort({ created_at: 1 })
    .toArray();
  return rows.map(toCandidateSeries);
}

async function cascadeSeriesReviewToEvents(
  db: Db,
  queryObjectId: ObjectId,
  approveIds: string[],
  dismissIds: string[]
): Promise<void> {
  const approved = approveIds.map(toObjectId).filter((id): id is ObjectId => id !== null);
  const dismissed = dismissIds.map(toObjectId).filter((id): id is ObjectId => id !== null);
  // Dismiss wins on overlap: approve first, then dismiss overwrites.
  if (approved.length > 0) {
    await db.collection('events').updateMany(
      { query_id: queryObjectId, series_id: { $in: approved }, status: 'candidate' },
      { $set: { status: 'approved' } }
    );
  }
  if (dismissed.length > 0) {
    await db.collection('events').updateMany(
      { query_id: queryObjectId, series_id: { $in: dismissed }, status: { $in: ['candidate', 'approved'] } },
      { $set: { status: 'dismissed' } }
    );
  }
}

async function setSeriesStatus(
  db: Db,
  queryObjectId: ObjectId,
  seriesIds: string[],
  status: SeriesStatus
): Promise<void> {
  const objectIds = seriesIds.map(toObjectId).filter((id): id is ObjectId => id !== null);
  if (objectIds.length === 0) return;
  await db
    .collection('series')
    .updateMany({ query_id: queryObjectId, _id: { $in: objectIds } }, { $set: { status } });
}
