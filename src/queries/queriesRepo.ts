import { ObjectId, type Db } from 'mongodb';
import type { ExtractedEvent, CandidateEvent } from '../types.js';

export async function createQueryWithCandidates(
  db: Db,
  userId: string,
  queryText: string,
  events: ExtractedEvent[]
): Promise<{ queryId: string; candidates: CandidateEvent[] }> {
  const queryResult = await db.collection('queries').insertOne({
    user_id: userId,
    query_text: queryText,
    recurrence_interval: 'monthly',
    created_at: new Date(),
  });
  const queryId = queryResult.insertedId.toString();

  if (events.length === 0) {
    return { queryId, candidates: [] };
  }

  // insertMany() rather than N sequential insertOne() calls — this runs
  // inline on the synchronous POST /api/queries hot path, already paying
  // for a live searxng call plus an opencode round trip.
  const now = new Date();
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