import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { startScheduler, type SchedulerCollaborators } from './scheduler';
import type { DueQuery } from './dueQueries';
import type { ScheduledRunDeps } from './scheduledRun';

describe('startScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const db = {} as Db;
  const deps: ScheduledRunDeps = {
    runQuery: vi.fn(),
    emailSender: { send: vi.fn() },
    publicBaseUrl: 'http://localhost:3000',
  };

  it('checks for due queries immediately on start, then again every interval', async () => {
    const findDueQueries = vi.fn().mockResolvedValue([]);
    const runScheduledQuery = vi.fn();
    const collaborators: SchedulerCollaborators = { findDueQueries, runScheduledQuery };

    const { stop } = startScheduler(db, deps, 1000, collaborators);
    await vi.advanceTimersByTimeAsync(0);
    expect(findDueQueries).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(findDueQueries).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(findDueQueries).toHaveBeenCalledTimes(2);
  });

  it('runs every due query returned by the finder', async () => {
    const due: DueQuery[] = [
      { _id: new ObjectId(), user_id: 'u1', query_text: 'A', recurrence_interval: 'weekly' },
      { _id: new ObjectId(), user_id: 'u2', query_text: 'B', recurrence_interval: 'weekly' },
    ];
    const findDueQueries = vi.fn().mockResolvedValue(due);
    const runScheduledQuery = vi.fn().mockResolvedValue(undefined);
    const collaborators: SchedulerCollaborators = { findDueQueries, runScheduledQuery };

    const { stop } = startScheduler(db, deps, 1000, collaborators);
    await vi.advanceTimersByTimeAsync(0);

    expect(runScheduledQuery).toHaveBeenCalledTimes(2);
    expect(runScheduledQuery).toHaveBeenNthCalledWith(1, db, due[0], deps);
    expect(runScheduledQuery).toHaveBeenNthCalledWith(2, db, due[1], deps);
    stop();
  });

  it('logs and continues past one query failing, instead of stopping the batch', async () => {
    const due: DueQuery[] = [
      { _id: new ObjectId(), user_id: 'u1', query_text: 'A', recurrence_interval: 'weekly' },
      { _id: new ObjectId(), user_id: 'u2', query_text: 'B', recurrence_interval: 'weekly' },
    ];
    const findDueQueries = vi.fn().mockResolvedValue(due);
    const runScheduledQuery = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const collaborators: SchedulerCollaborators = { findDueQueries, runScheduledQuery };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { stop } = startScheduler(db, deps, 1000, collaborators);
    await vi.advanceTimersByTimeAsync(0);

    expect(runScheduledQuery).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
    stop();
  });

  it('processes due queries sequentially, not concurrently', async () => {
    const order: string[] = [];
    const due: DueQuery[] = [
      { _id: new ObjectId(), user_id: 'u1', query_text: 'A', recurrence_interval: 'weekly' },
      { _id: new ObjectId(), user_id: 'u2', query_text: 'B', recurrence_interval: 'weekly' },
    ];
    const findDueQueries = vi.fn().mockResolvedValue(due);
    const runScheduledQuery = vi.fn(async (_db: Db, query: DueQuery) => {
      order.push(`start:${query.user_id}`);
      if (query.user_id === 'u1') {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      order.push(`end:${query.user_id}`);
    });
    const collaborators: SchedulerCollaborators = { findDueQueries, runScheduledQuery };

    const { stop } = startScheduler(db, deps, 1000, collaborators);
    await vi.advanceTimersByTimeAsync(500);

    expect(order).toEqual(['start:u1', 'end:u1', 'start:u2', 'end:u2']);
    stop();
  });
});
