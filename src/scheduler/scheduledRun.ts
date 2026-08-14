import { ObjectId, type Db } from 'mongodb';
import type { EmailSender } from '../email/EmailSender.js';
import type { ExtractedEvent } from '../types.js';
import type { DueQuery } from './dueQueries.js';
import { filterNewEvents, type ExistingEventKey } from './dedupeEvents.js';

export interface ScheduledRunDeps {
  runQuery: (query: string) => Promise<ExtractedEvent[]>;
  emailSender: EmailSender;
  publicBaseUrl: string;
}

interface ExistingEventRow extends ExistingEventKey {
  status: 'candidate' | 'approved';
}

export async function runScheduledQuery(db: Db, query: DueQuery, deps: ScheduledRunDeps): Promise<void> {
  const existingEvents = await db
    .collection<ExistingEventRow>('events')
    .find({ query_id: query._id })
    .toArray();

  const extracted = await deps.runQuery(query.query_text);
  const newEvents = filterNewEvents(extracted, existingEvents);

  if (newEvents.length > 0) {
    const isTrusted = existingEvents.some(e => e.status === 'approved');
    const status = isTrusted ? 'approved' : 'candidate';
    const insertedAt = new Date();

    await db.collection('events').insertMany(
      newEvents.map(event => ({
        _id: new ObjectId(),
        query_id: query._id,
        label: event.label,
        start_date: event.startDate,
        end_date: event.endDate,
        source_url: event.sourceUrl,
        status,
        created_at: insertedAt,
      }))
    );

    await sendReRunEmail(db, query, newEvents.length, isTrusted, deps);
  }

  await db.collection('queries').updateOne({ _id: query._id }, { $set: { last_run_at: new Date() } });
}

async function sendReRunEmail(
  db: Db,
  query: DueQuery,
  count: number,
  isTrusted: boolean,
  deps: ScheduledRunDeps
): Promise<void> {
  try {
    const user = await db
      .collection<{ _id: ObjectId; email: string }>('users')
      .findOne({ _id: new ObjectId(query.user_id) });
    if (!user) return;

    const plural = count === 1 ? '' : 's';
    const subject = isTrusted
      ? `${count} new date${plural} added to your feed`
      : `${count} new date${plural} found — go review`;
    const body = isTrusted
      ? `"${query.query_text}" found ${count} new date${plural}, already added to your feed.\n\n${deps.publicBaseUrl}`
      : `"${query.query_text}" found ${count} new date${plural} awaiting your review.\n\n${deps.publicBaseUrl}`;

    await deps.emailSender.send(user.email, subject, body);
  } catch (err) {
    console.error(`Failed to send re-run email for query ${query._id.toString()}:`, err);
  }
}
