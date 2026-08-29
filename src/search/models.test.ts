import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Db, MongoClient } from 'mongodb';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../testSupport';
import { createModelRegistry } from './models.js';

describe('model registry', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    ({ client, db } = await setupTestDb());
  });

  beforeEach(async () => {
    await cleanTestDb(db);
  });

  afterAll(async () => {
    await teardownTestDb(client);
  });

  it('seeds default and backup models when the registry is empty', async () => {
    const registry = createModelRegistry({ db });
    const active = await registry.listActive();
    expect(active).toEqual([
      { id: 'qwen3.7-flash', providerID: 'bailian-payg' },
      { id: 'antigravity-gemini-3-flash', providerID: 'google' },
    ]);
  });

  it('orders the active tiers default-first, then backups', async () => {
    const registry = createModelRegistry({ db });
    // Promote the backup to default; the old default becomes a backup via
    // the update below (it keeps its role unless cleared).
    await registry.update('antigravity-gemini-3-flash', { role: 'default' });
    await registry.update('qwen3.7-flash', { role: 'backup' });
    await registry.add({ id: 'tertiary', providerID: 'opencode' });

    const active = await registry.listActive();
    expect(active.map(m => m.id)).toEqual(['antigravity-gemini-3-flash', 'qwen3.7-flash', 'tertiary']);
  });

  it('excludes retired models from the active list', async () => {
    const registry = createModelRegistry({ db });
    await registry.update('qwen3.7-flash', { enabled: false });

    const active = await registry.listActive();
    expect(active).toEqual([{ id: 'antigravity-gemini-3-flash', providerID: 'google' }]);
  });

  it('rejects adding a duplicate model id', async () => {
    const registry = createModelRegistry({ db });
    const added = await registry.add({ id: 'brand-new', providerID: 'opencode' });
    expect(added).not.toBeNull();

    const duplicate = await registry.add({ id: 'brand-new', providerID: 'opencode' });
    expect(duplicate).toBeNull();
  });

  it('returns null when updating a missing model', async () => {
    const registry = createModelRegistry({ db });
    expect(await registry.update('does-not-exist', { enabled: false })).toBeNull();
  });
});
