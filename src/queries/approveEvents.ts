import { ObjectId, type Db } from 'mongodb';
import { getOrCreateFeedToken } from '../feed/feedToken';

export async function approveEvents(
  db: Db,
  userId: string,
  queryId: string,
  eventIds: string[],
  publicBaseUrl: string
): Promise<{ icsUrl: string; rssUrl: string } | null> {
  const ownership = await db.collection('queries').findOne({
    _id: new ObjectId(queryId),
    user_id: userId,
  });
  if (!ownership) {
    return null;
  }

  if (eventIds.length > 0) {
    await db.collection('events').updateMany(
      {
        query_id: new ObjectId(queryId),
        _id: { $in: eventIds.map(id => new ObjectId(id)) },
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