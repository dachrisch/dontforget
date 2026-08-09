import { ObjectId, type Db } from 'mongodb';
import type { ExtractedEvent, CandidateEvent } from '../types';

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

  const candidates: CandidateEvent[] = [];
  for (const event of events) {
    const { insertedId } = await db.collection('events').insertOne({
      query_id: new ObjectId(queryId),
      label: event.label,
      start_date: event.startDate,
      end_date: event.endDate,
      source_url: event.sourceUrl,
      status: 'candidate',
      created_at: new Date(),
    });
    candidates.push({ ...event, id: insertedId.toString(), status: 'candidate' });
  }

  return { queryId, candidates };
}