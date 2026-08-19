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
      { id: 'deepseek-v4-flash-free', providerID: 'opencode' },
      { id: 'big-pickle', providerID: 'opencode' },
    ]);
  });

  it('orders the active tiers default-first, then backups', async () => {
    const registry = createModelRegistry({ db });
    // Promote the backup to default; the old default becomes a backup via
    // the update below (it keeps its role unless cleared).
    await registry.update('big-pickle', { role: 'default' });
    await registry.update('deepseek-v4-flash-free', { role: 'backup' });
    await registry.add({ id: 'tertiary', providerID: 'opencode' });

    const active = await registry.listActive();
    expect(active.map(m => m.id)).toEqual(['big-pickle', 'deepseek-v4-flash-free', 'tertiary']);
  });

  it('excludes retired models from the active list', async () => {
    const registry = createModelRegistry({ db });
    await registry.update('deepseek-v4-flash-free', { enabled: false });

    const active = await registry.listActive();
    expect(active).toEqual([{ id: 'big-pickle', providerID: 'opencode' }]);
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
