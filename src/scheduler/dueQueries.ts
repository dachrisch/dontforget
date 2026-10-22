import { ObjectId, type Db } from 'mongodb';
import { DEFAULT_RECURRENCE_INTERVAL, type RecurrenceInterval } from '../types.js';
import { isDue } from './recurrence.js';

export interface DueQuery {
  _id: ObjectId;
  user_id: string;
  query_text: string;
  recurrence_interval: RecurrenceInterval;
}

interface QueryRow {
  _id: ObjectId;
  user_id: string;
  query_text: string;
  recurrence_interval?: RecurrenceInterval;
  last_run_at?: Date | null;
}

export async function findDueQueries(db: Db, now: Date): Promise<DueQuery[]> {
  const rows = await db.collection<QueryRow>('queries').find({ active: { $ne: false } }).toArray();

  return rows
    .filter(row => {
      if (row.last_run_at != null) return true;
      // Every query gets last_run_at stamped at creation (queriesRepo.ts),
      // so this shouldn't happen — but if it ever does, log it instead of
      // silently dropping the query into a permanently-dead state.
      console.warn(`Query ${row._id.toString()} has no last_run_at, skipping`);
      return false;
    })
    .filter(row => isDue(row.last_run_at as Date, row.recurrence_interval ?? DEFAULT_RECURRENCE_INTERVAL, now))
    .map(row => ({
      _id: row._id,
      user_id: row.user_id,
      query_text: row.query_text,
      recurrence_interval: row.recurrence_interval ?? DEFAULT_RECURRENCE_INTERVAL,
    }));
}
