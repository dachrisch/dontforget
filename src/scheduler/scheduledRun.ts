import { ObjectId, type Db } from 'mongodb';
import type { EmailSender } from '../email/EmailSender.js';
import type { ExtractionResult } from '../types.js';
import type { DueQuery } from './dueQueries.js';
import { filterNewEvents, type ExistingEventKey } from './dedupeEvents.js';
import { getOrCreateFeedToken } from '../feed/feedToken.js';
import { completeSeriesExpansion } from '../queries/queriesRepo.js';
import { setSeriesExpanding, type SeriesRow } from '../queries/seriesRepo.js';
import type { SeriesScope } from '../search/opencodeClient.js';
import { plausibleDateWindow } from './recurrence.js';

export interface ScheduledRunDeps {
  runQuery: (query: string) => Promise<ExtractionResult>;
  // Series-scoped expansion (only dates that are occurrences of what the
  // series applies to). Falls back to runQuery on the series' keywords.
  runSeriesExpansion?: (series: SeriesScope) => Promise<ExtractionResult>;
  emailSender: EmailSender;
  publicBaseUrl: string;
}

interface ExistingEventRow extends ExistingEventKey {
  status: 'candidate' | 'approved' | 'dismissed';
}

export async function runScheduledQuery(db: Db, query: DueQuery, deps: ScheduledRunDeps): Promise<void> {
  // Two-stage pipeline (issue #143): scheduled re-runs expand per approved
  // series, not the raw broad query. Dismissed/candidate series are never
  // expanded; dismissed titles are never re-created (insert path dedupes).
  // Queries with no series rows at all (pre-migration, or unit tests using
  // the legacy helper) fall back to the legacy raw-query path.
  const seriesRows = await db
    .collection<SeriesRow>('series')
    .find({ query_id: query._id })
    .toArray();
  if (seriesRows.length > 0) {
    await runScheduledSeriesExpansion(db, query, seriesRows, deps);
    return;
  }
  await runLegacyScheduledQuery(db, query, deps);
}

async function runScheduledSeriesExpansion(
  db: Db,
  query: DueQuery,
  seriesRows: SeriesRow[],
  deps: ScheduledRunDeps
): Promise<void> {
  const approved = seriesRows.filter(s => s.status === 'approved');
  if (approved.length === 0) {
    // Nothing trusted to expand — still advance the schedule so the query
    // doesn't go permanently due. Discovery re-runs only on explicit
    // refresh, not here.
    await db
      .collection('queries')
      .updateOne({ _id: query._id }, { $set: { last_run_at: new Date(), status: 'ready' as const } });
    return;
  }

  let totalNew = 0;
  const expandedNames: string[] = [];
  try {
    // One searxng call per subscribed series (cost guardrail); sequential so
    // date-dedupe sees each series' inserts before the next runs. Each
    // lookup is scoped to what that series applies to.
    for (const series of approved) {
      const scope: SeriesScope = {
        title: series.title,
        appliesTo: series.applies_to ?? series.title,
        description: series.description,
        searchKeywords: series.search_keywords,
        window: plausibleDateWindow(query.recurrence_interval),
      };
      // Flag the series while its lookup runs so the dashboard dot pulses;
      // cleared in `finally` even when the expansion throws.
      await setSeriesExpanding(db, query._id, [series._id], true);
      try {
        const extracted = deps.runSeriesExpansion
          ? await deps.runSeriesExpansion(scope)
          : await deps.runQuery(series.search_keywords);
        const inserted = await completeSeriesExpansion(db, query._id, series._id, extracted.events);
        if (inserted.length > 0) {
          totalNew += inserted.length;
          expandedNames.push(series.applies_to ?? series.title);
        }
      } finally {
        await setSeriesExpanding(db, query._id, [series._id], false).catch(() => undefined);
      }
    }
  } catch (err) {
    await db
      .collection('queries')
      .updateOne({ _id: query._id }, { $set: { status: 'failed' as const } })
      .catch(() => undefined);
    throw err;
  }

  if (totalNew > 0) {
    // Subscribed-series expansions land as approved (trusted), so the email
    // is always the FYI variant — and it names the subscribed series, since
    // that is what the user follows.
    await sendReRunEmail(db, query, totalNew, true, deps, expandedNames);
  }

  await db.collection('queries').updateOne(
    { _id: query._id },
    { $set: { last_run_at: new Date(), status: 'ready' as const } }
  );
}

async function runLegacyScheduledQuery(db: Db, query: DueQuery, deps: ScheduledRunDeps): Promise<void> {
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

    // Same as completeQueryRun: the feed must exist while candidates are
    // still awaiting review, so the review entries have somewhere to appear.
    await getOrCreateFeedToken(db, query.user_id);

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
  deps: ScheduledRunDeps,
  seriesNames: string[] = []
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
    // Series names and query_text are partly model- or user-controlled free
    // text embedded in an email header (not just the body) — strip
    // newlines/carriage returns first to guard against header injection.
    const safeNames = seriesNames.map(n => n.replace(/[\r\n]+/g, ' ').trim()).filter(n => n.length > 0);
    const subjectScope = safeNames.length > 0 ? safeNames.join(', ') : query.query_text.replace(/[\r\n]+/g, ' ');
    const subject = isTrusted
      ? `${count} new date${plural} added to your feed for '${subjectScope}'`
      : `${count} new date${plural} found for '${subjectScope}' — go review`;
    const bodyScope = safeNames.length > 0
      ? `Your subscribed series ${safeNames.map(n => `"${n}"`).join(', ')} found ${count} new date${plural}, already added to your feed.`
      : `"${query.query_text}" found ${count} new date${plural}, already added to your feed.`;
    const body = isTrusted
      ? `${bodyScope}\n\n${deps.publicBaseUrl}`
      : `"${subjectScope}" found ${count} new date${plural} awaiting your review.\n\n${deps.publicBaseUrl}`;

    await deps.emailSender.send(user.email, subject, body);
  } catch (err) {
    console.error(`Failed to send re-run email for query ${query._id.toString()}:`, err);
  }
}
