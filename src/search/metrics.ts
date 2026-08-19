import type { Db } from 'mongodb';

// Call-level metrics for the LLM and search providers, surfaced to admins
// so they can judge model performance and search availability at a glance.
// Recording is intentionally fire-and-forget: a metrics write failure must
// never break the search or extraction that produced the metric.

export type CallOutcome = 'success' | 'failure';

export interface ModelCallMetric {
  modelId: string;
  providerId: string;
  outcome: CallOutcome;
  errorType?: string | null;
  durationMs: number;
  createdAt?: Date;
}

export interface SearchCallMetric {
  outcome: CallOutcome;
  errorType?: string | null;
  resultCount: number;
  durationMs: number;
  createdAt?: Date;
}

export interface MetricsService {
  recordModelCall: (entry: ModelCallMetric) => Promise<void>;
  recordSearchCall: (entry: SearchCallMetric) => Promise<void>;
}

const NullMetrics: MetricsService = {
  async recordModelCall() {},
  async recordSearchCall() {},
};

export function createMetricsService(db: Db | null): MetricsService {
  if (!db) return NullMetrics;
  return {
    async recordModelCall(entry) {
      try {
        await db.collection('model_metrics').insertOne({
          model_id: entry.modelId,
          provider_id: entry.providerId,
          outcome: entry.outcome,
          error_type: entry.errorType ?? null,
          duration_ms: entry.durationMs,
          created_at: entry.createdAt ?? new Date(),
        });
      } catch {
        // swallow — metrics are advisory
      }
    },
    async recordSearchCall(entry) {
      try {
        await db.collection('search_metrics').insertOne({
          outcome: entry.outcome,
          error_type: entry.errorType ?? null,
          result_count: entry.resultCount,
          duration_ms: entry.durationMs,
          created_at: entry.createdAt ?? new Date(),
        });
      } catch {
        // swallow — metrics are advisory
      }
    },
  };
}
