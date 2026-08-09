import type { Db } from 'mongodb';
import { migrate as migrate001 } from '../migrations/001_init';

interface Migration {
  name: string;
  migrate: (db: Db) => Promise<void>;
}

// Migrations live under src/ so tsc, tsx, and vitest all compile them identically.
// Add new ones by importing them here and appending to this registry.
const MIGRATIONS: Migration[] = [{ name: '001_init.ts', migrate: migrate001 }];

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