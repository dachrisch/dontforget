import type { Db } from 'mongodb';

export async function migrate(db: Db): Promise<void> {
  // `models` holds the admin-managed LLM model registry: which model is the
  // default, which are backups, and which are retired (disabled). Admin
  // switches default/backup and retires models here; the search pipeline
  // reads the enabled tiers fresh on every run.
  await db.createCollection('models');
  await db.collection('models').createIndex({ id: 1 }, { unique: true });

  // One document per LLM attempt (per model tried) and per search call, so
  // admins can see success/failure rates, latency and availability. Fields
  // are written by the metrics service at call time — only the indexes live
  // here.
  await db.createCollection('model_metrics');
  await db.collection('model_metrics').createIndex({ created_at: -1 });
  await db.collection('model_metrics').createIndex({ model_id: 1, created_at: -1 });

  await db.createCollection('search_metrics');
  await db.collection('search_metrics').createIndex({ created_at: -1 });
}
