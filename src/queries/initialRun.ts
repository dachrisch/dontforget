import type { Db } from 'mongodb';
import type { ObjectId } from 'mongodb';
import type { ExtractionResult } from '../types.js';
import { completeQueryRun, markQueryFailed } from './queriesRepo.js';

export interface InitialRunDeps {
  runQuery: (query: string) => Promise<ExtractionResult>;
  // True when the client did not pass an explicit recurrence interval, so
  // the AI-suggested cadence from this run may fill the slot. An explicit
  // user choice always wins over the suggestion.
  applyCadence: boolean;
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
    const { events, cadence } = await deps.runQuery(query.query_text);
    await completeQueryRun(db, query._id, events, deps.applyCadence ? cadence : null);
  } catch (err) {
    console.error(`Initial search failed for query ${query._id.toString()}:`, err);
    await markQueryFailed(db, query._id);
  }
}
