import { ObjectId, type Db } from 'mongodb';
import type { CandidateSeries, ExtractedSeries, SeriesStatus } from '../types.js';
import { MAX_SERIES } from '../search/opencodeClient.js';

export interface SeriesRow {
  _id: ObjectId;
  query_id: ObjectId;
  user_id: string;
  title: string;
  normalized_title: string;
  description: string;
  search_keywords: string;
  source_urls: string[];
  status: SeriesStatus;
  created_at: Date;
}

// Normalized-title dedupe key: dismissed series are never re-created on
// re-run, and repeated discoveries of the same series collapse to one row.
export function normalizeSeriesTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

function toCandidateSeries(row: SeriesRow): CandidateSeries {
  return {
    id: row._id.toString(),
    title: row.title,
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
    .find({ query_id: queryId }, { projection: { normalized_title: 1 } })
    .toArray();
  const seen = new Set(existing.map(r => r.normalized_title));

  const now = new Date();
  const docs: SeriesRow[] = [];
  for (const entry of series) {
    const title = entry.title.trim();
    const searchKeywords = entry.searchKeywords.trim();
    const sourceUrls = entry.sourceUrls.map(u => u.trim()).filter(u => u.length > 0);
    if (!title || !searchKeywords || sourceUrls.length === 0) continue;
    const key = normalizeSeriesTitle(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    docs.push({
      _id: new ObjectId(),
      query_id: queryId,
      user_id: userId,
      title,
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

  const rows = await db
    .collection<SeriesRow>('series')
    .find({ query_id: queryObjectId })
    .sort({ created_at: 1 })
    .toArray();
  return rows.map(toCandidateSeries);
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
