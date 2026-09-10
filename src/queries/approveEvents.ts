import { ObjectId, type Db } from 'mongodb';
import { getOrCreateFeedToken } from '../feed/feedToken.js';
import { buildFeedUrls } from '../feed/feedUrl.js';
import type { RecurrenceInterval } from '../types.js';

export interface ApproveEventsResult {
  icsUrl: string;
  rssUrl: string;
  // Parent series that this call subscribed by approving their dates. Lets
  // callers (and the UI) see the series-level effect of a per-event batch —
  // dismissals never appear here, they stay strictly per-event.
  subscribedSeriesIds: string[];
}

export async function approveEvents(
  db: Db,
  userId: string,
  queryId: string,
  eventIds: string[],
  publicBaseUrl: string,
  recurrenceInterval?: RecurrenceInterval,
  dismissEventIds: string[] = []
): Promise<ApproveEventsResult | null> {
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

  // Subscription semantics (issue #143): approving individual dates of a
  // series subscribes to the series itself, so its future dates are picked
  // up by scheduled re-runs without further approval. Dismissing dates
  // stays per-event — the subscription itself is only dropped by
  // dismissing the series.
  const subscribedSeriesIds = await approveParentSeriesOfEvents(db, queryObjectId, eventIds, dismissEventIds);

  const token = await getOrCreateFeedToken(db, userId);
  return { ...buildFeedUrls(publicBaseUrl, token), subscribedSeriesIds };
}

async function approveParentSeriesOfEvents(
  db: Db,
  queryObjectId: ObjectId,
  approvedIds: string[],
  dismissedIds: string[]
): Promise<string[]> {
  const approved = approvedIds.map(toObjectId).filter((id): id is ObjectId => id !== null);
  if (approved.length === 0) return [];
  // Dismiss wins on overlap: events approved AND dismissed stay dismissed,
  // so their series must not be subscribed.
  const dismissed = new Set(
    dismissedIds.map(toObjectId).filter((id): id is ObjectId => id !== null).map(id => id.toString())
  );
  const rows = await db
    .collection<{ _id: ObjectId; series_id?: ObjectId }>('events')
    .find({ query_id: queryObjectId, _id: { $in: approved } }, { projection: { series_id: 1 } })
    .toArray();
  const seriesIds = [
    ...new Set(
      rows
        .filter(r => r.series_id && !dismissed.has(r._id.toString()))
        .map(r => r.series_id as ObjectId)
    ),
  ];
  if (seriesIds.length === 0) return [];
  await db
    .collection('series')
    .updateMany({ query_id: queryObjectId, _id: { $in: seriesIds } }, { $set: { status: 'approved' } });
  return seriesIds.map(id => id.toString());
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
