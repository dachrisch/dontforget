import type { Db } from 'mongodb';
import type { ObjectId } from 'mongodb';
import type { ExtractionResult, SeriesExtractionResult } from '../types.js';
import { completeQueryRun, completeSeriesDiscoveryRun, markQueryFailed } from './queriesRepo.js';
import { insertDiscoveredSeries } from './seriesRepo.js';

export interface InitialRunDeps {
  runQuery: (query: string) => Promise<ExtractionResult>;
  // Stage 1 of the two-stage pipeline (issue #143): groups the query into
  // reviewable series. When present, the initial run discovers series only
  // and inserts zero dated events — per-series expansion happens after the
  // user approves a series. Absent (older callers/tests), falls back to the
  // legacy single-stage path.
  discoverSeries?: (query: string) => Promise<SeriesExtractionResult>;
  // True when the client did not pass an explicit recurrence interval, so
  // the AI-suggested cadence from this run may fill the slot. An explicit
  // user choice always wins over the suggestion.
  applyCadence: boolean;
  // Resolves the user that owns the query (for series rows). Defaults to
  // reading user_id from the queries collection.
  userId?: string;
}

export interface InitialRunQuery {
  _id: ObjectId;
  query_text: string;
}

// Runs a brand-new query's first search in the background. Everything it
// does must be self-contained — it catches its own errors and flips the
// query to `failed` instead of letting an unhandled rejection escape.
export async function runInitialQuery(db: Db, query: InitialRunQuery, deps: InitialRunDeps): Promise<void> {
  try {
    if (deps.discoverSeries) {
      const { series } = await deps.discoverSeries(query.query_text);
      let userId = deps.userId;
      if (!userId) {
        const row = await db
          .collection<{ _id: ObjectId; user_id: string }>('queries')
          .findOne({ _id: query._id }, { projection: { user_id: 1 } });
        userId = row?.user_id;
      }
      if (userId) {
        await insertDiscoveredSeries(db, query._id, userId, series);
      }
      // Zero direct dated events before series approval (acceptance
      // criterion): the query lands as ready with series candidates only.
      await completeSeriesDiscoveryRun(db, query._id);
      return;
    }
    const { events, cadence } = await deps.runQuery(query.query_text);
    await completeQueryRun(db, query._id, events, deps.applyCadence ? cadence : null);
  } catch (err) {
    console.error(`Initial search failed for query ${query._id.toString()}:`, err);
    await markQueryFailed(db, query._id);
  }
}
