import type { Db } from 'mongodb';
import { migrate as migrate001 } from '../migrations/001_init.js';
import { migrate as migrate002 } from '../migrations/002_queries_dashboard.js';
import { migrate as migrate003 } from '../migrations/003_events_dedup_index.js';
import { migrate as migrate004 } from '../migrations/004_models_metrics.js';
import { migrate as migrate005 } from '../migrations/005_swap_dead_models.js';
import { migrate as migrate006 } from '../migrations/006_swap_default_model.js';

interface Migration {
  name: string;
  migrate: (db: Db) => Promise<void>;
}

// Migrations live under src/ so tsc, tsx, and vitest all compile them identically.
// Add new ones by importing them here and appending to this registry.
const MIGRATIONS: Migration[] = [
  { name: '001_init.ts', migrate: migrate001 },
  { name: '002_queries_dashboard.ts', migrate: migrate002 },
  { name: '003_events_dedup_index.ts', migrate: migrate003 },
  { name: '004_models_metrics.ts', migrate: migrate004 },
  { name: '005_swap_dead_models.ts', migrate: migrate005 },
  { name: '006_swap_default_model.ts', migrate: migrate006 },
];

export async function runMigrations(db: Db): Promise<string[]> {
  // No explicit createCollection here: Mongo creates a collection lazily on
  // first write, and createCollection() throws NamespaceExists if called
  // again on a database that's already been migrated once.

  const applied = new Set(
    (await db.collection('schema_migrations').find().toArray()).map(r => r.name as string)
  );

  const newlyApplied: string[] = [];

  for (const { name, migrate } of MIGRATIONS) {
    if (applied.has(name)) continue;
    await migrate(db);
    await db.collection('schema_migrations').insertOne({ name, applied_at: new Date() });
    newlyApplied.push(name);
  }

  return newlyApplied;
}