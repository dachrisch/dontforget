import { ObjectId, type Db } from 'mongodb';
import type { EmailSender } from '../email/EmailSender.js';
import type { ExtractionResult } from '../types.js';
import type { DueQuery } from './dueQueries.js';
import { filterNewEvents, type ExistingEventKey } from './dedupeEvents.js';

export interface ScheduledRunDeps {
  runQuery: (query: string) => Promise<ExtractionResult>;
  emailSender: EmailSender;
  publicBaseUrl: string;
}

interface ExistingEventRow extends ExistingEventKey {
  status: 'candidate' | 'approved' | 'dismissed';
}

export async function runScheduledQuery(db: Db, query: DueQuery, deps: ScheduledRunDeps): Promise<void> {
  // Dedup set and trust are snapshotted here, before deps.runQuery (the
  // orchestrator, which can take a while — real search + LLM extraction)
  // runs — not re-read afterward. If a user approves this query's
  // first-ever event mid-run, this run still treats it as untrusted. That's
  // deliberate: it's benign (one extra review) and saves a second DB
  // round-trip after the orchestrator returns.
  const existingEvents = await db
    .collection<ExistingEventRow>('events')
    .find({ query_id: query._id }, { projection: { _id: 0, start_date: 1, end_date: 1, status: 1 } })
    .toArray();

  let extracted: ExtractionResult;
  try {
    extracted = await deps.runQuery(query.query_text);
  } catch (err) {
    // A query that was stuck in `running` (e.g. the server died mid-search)
    // must not stay stuck forever — mark it failed so the dashboard card
    // shows an actionable state, then let the scheduler log the failure.
    await db
      .collection('queries')
      .updateOne({ _id: query._id }, { $set: { status: 'failed' as const } })
      .catch(() => undefined);
    throw err;
  }
  const newEvents = filterNewEvents(extracted.events, existingEvents);

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

  await db.collection('queries').updateOne(
    { _id: query._id },
    { $set: { last_run_at: new Date(), status: 'ready' as const } }
  );
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
    if (!user) {
      console.warn(
        `Cannot send re-run email: no user found for query ${query._id.toString()} (user_id ${query.user_id})`
      );
      return;
    }

    const plural = count === 1 ? '' : 's';
    // query_text is user-controlled free text embedded in an email header
    // (not just the body) — strip newlines/carriage returns first to guard
    // against header injection.
    const safeQueryText = query.query_text.replace(/[\r\n]+/g, ' ');
    const subject = isTrusted
      ? `${count} new date${plural} added to your feed for '${safeQueryText}'`
      : `${count} new date${plural} found for '${safeQueryText}' — go review`;
    const body = isTrusted
      ? `"${query.query_text}" found ${count} new date${plural}, already added to your feed.\n\n${deps.publicBaseUrl}`
      : `"${query.query_text}" found ${count} new date${plural} awaiting your review.\n\n${deps.publicBaseUrl}`;

    await deps.emailSender.send(user.email, subject, body);
  } catch (err) {
    console.error(`Failed to send re-run email for query ${query._id.toString()}:`, err);
  }
}
