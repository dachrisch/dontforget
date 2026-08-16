import { ObjectId, type Db } from 'mongodb';
import { getOrCreateFeedToken } from '../feed/feedToken.js';
import type { RecurrenceInterval } from '../types.js';

export async function approveEvents(
  db: Db,
  userId: string,
  queryId: string,
  eventIds: string[],
  publicBaseUrl: string,
  recurrenceInterval?: RecurrenceInterval
): Promise<{ icsUrl: string; rssUrl: string } | null> {
  const queryObjectId = toObjectId(queryId);
  if (!queryObjectId) {
    return null;
  }

  const ownership = await db.collection('queries').findOne({
    _id: queryObjectId,
    user_id: userId,
  });
  if (!ownership) {
    return null;
  }

  if (recurrenceInterval) {
    await db
      .collection('queries')
      .updateOne({ _id: queryObjectId }, { $set: { recurrence_interval: recurrenceInterval } });
  }

  const eventObjectIds = eventIds.map(toObjectId).filter((id): id is ObjectId => id !== null);
  if (eventObjectIds.length > 0) {
    await db.collection('events').updateMany(
      {
        query_id: queryObjectId,
        _id: { $in: eventObjectIds },
      },
      { $set: { status: 'approved' } }
    );
  }

  const token = await getOrCreateFeedToken(db, userId);
  return {
    icsUrl: `${publicBaseUrl}/f/${token}.ics`,
    rssUrl: `${publicBaseUrl}/f/${token}.rss`,
  };
}

function toObjectId(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}