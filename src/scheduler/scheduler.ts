import type { Db } from 'mongodb';
import { findDueQueries as defaultFindDueQueries, type DueQuery } from './dueQueries.js';
import { runScheduledQuery as defaultRunScheduledQuery, type ScheduledRunDeps } from './scheduledRun.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface SchedulerCollaborators {
  findDueQueries: (db: Db, now: Date) => Promise<DueQuery[]>;
  runScheduledQuery: (db: Db, query: DueQuery, deps: ScheduledRunDeps) => Promise<void>;
}

const defaultCollaborators: SchedulerCollaborators = {
  findDueQueries: defaultFindDueQueries,
  runScheduledQuery: defaultRunScheduledQuery,
};

export function startScheduler(
  db: Db,
  deps: ScheduledRunDeps,
  intervalMs: number = ONE_DAY_MS,
  collaborators: SchedulerCollaborators = defaultCollaborators
): { stop: () => void } {
  async function tick(): Promise<void> {
    let due: DueQuery[];
    try {
      due = await collaborators.findDueQueries(db, new Date());
    } catch (err) {
      console.error('Scheduler tick failed to find due queries:', err);
      return;
    }
    for (const query of due) {
      try {
        await collaborators.runScheduledQuery(db, query, deps);
      } catch (err) {
        console.error(`Scheduled run failed for query ${query._id.toString()}:`, err);
      }
    }
  }

  tick();
  const timer = setInterval(tick, intervalMs);
  return { stop: () => clearInterval(timer) };
}
