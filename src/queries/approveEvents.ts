import { ObjectId, type Db } from 'mongodb';
import { getOrCreateFeedToken } from '../feed/feedToken.js';
import type { RecurrenceInterval } from '../types.js';

export async function approveEvents(
  db: Db,
  userId: string,
  queryId: string,
  eventIds: string[],
  publicBaseUrl: string,
  recurrenceInterval?: RecurrenceInterval,
  dismissEventIds: string[] = []
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

  // Contract: if the same event id appears in both eventIds and
  // dismissEventIds, dismiss wins — it runs second and its $set overwrites
  // whatever the approve call just wrote.
  await setEventStatus(db, queryObjectId, eventIds, 'approved');
  await setEventStatus(db, queryObjectId, dismissEventIds, 'dismissed');

  const token = await getOrCreateFeedToken(db, userId);
  return {
    icsUrl: `${publicBaseUrl}/f/${token}.ics`,
    rssUrl: `${publicBaseUrl}/f/${token}.rss`,
  };
}

async function setEventStatus(
  db: Db,
  queryObjectId: ObjectId,
  eventIds: string[],
  status: 'approved' | 'dismissed'
): Promise<void> {
  const objectIds = eventIds.map(toObjectId).filter((id): id is ObjectId => id !== null);
  if (objectIds.length === 0) return;
  await db.collection('events').updateMany(
    { query_id: queryObjectId, _id: { $in: objectIds } },
    { $set: { status } }
  );
}

function toObjectId(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}
