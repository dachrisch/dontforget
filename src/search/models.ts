import { ObjectId, type Db, type WithId } from 'mongodb';

// The model registry backs the admin's ability to switch the default and
// backup models and to retire (disable) models that are unresponsive. The
// search pipeline reads the enabled tiers fresh on every run, so an admin's
// change takes effect without a restart.
//
// `role` is `'default'` for the primary model and `'backup'` for each
// fallback tier; models with no role are in the pool but not selected unless
// they're assigned one. `enabled: false` retires a model entirely — it's
// never tried, regardless of role.

export type ModelRole = 'default' | 'backup';

export interface ModelConfig {
  _id?: ObjectId;
  id: string; // model id sent to the provider (e.g. 'deepseek-v4-flash-free')
  providerID: string; // provider namespace (e.g. 'opencode')
  role?: ModelRole;
  enabled: boolean;
  created_at?: Date;
  updated_at?: Date;
}

export interface ActiveModel {
  id: string;
  providerID: string;
}

export interface ModelPatch {
  enabled?: boolean;
  role?: ModelRole | null; // null clears the role
}

export interface ModelRegistryDeps {
  db: Db;
}

export interface ModelRegistry {
  listActive: () => Promise<ActiveModel[]>;
  list: () => Promise<WithId<ModelConfig>[]>;
  update: (modelId: string, patch: ModelPatch) => Promise<WithId<ModelConfig> | null>;
  add: (config: { id: string; providerID: string }) => Promise<WithId<ModelConfig> | null>;
}

// Empty, do-nothing registry for tests/callers that don't configure models.
export function createNoopModelRegistry(): ModelRegistry {
  return {
    async listActive() {
      return [];
    },
    async list() {
      return [];
    },
    async update() {
      return null;
    },
    async add() {
      return null;
    },
  };
}

// Defaults mirror the hard-coded tiers in opencodeClient.ts. As of
// 2026-09-01 the primary is "glm-5.3-flash" on the "opencode-go" provider
// (OpenCode Go); the backup stays on "google" (Antigravity) so an
// opencode-go outage fails over to a different provider. Seeded only when
// the registry is empty so an existing deployment keeps its current choices
// (and is migrated to these by 005_swap_dead_models / 006_swap_default_model).
const DEFAULT_MODELS: Array<{ id: string; providerID: string; role: ModelRole }> = [
  { id: 'glm-5.3-flash', providerID: 'opencode-go', role: 'default' },
  { id: 'antigravity-gemini-3-flash', providerID: 'google', role: 'backup' },
];

export function createModelRegistry(deps: ModelRegistryDeps): ModelRegistry {
  const col = () => deps.db.collection<ModelConfig>('models');

  async function seedIfEmpty(): Promise<void> {
    if ((await col().countDocuments()) > 0) return;
    await col().insertMany(
      DEFAULT_MODELS.map(m => ({ ...m, enabled: true, created_at: new Date() }))
    );
  }

  return {
    async listActive() {
      await seedIfEmpty();
      const rows = await col().find({ enabled: true }).toArray();
      const rank = (role?: ModelRole) => (role === 'default' ? 0 : role === 'backup' ? 1 : 2);
      return rows
        .sort((a, b) => rank(a.role) - rank(b.role) || a.created_at!.getTime() - b.created_at!.getTime())
        .map(row => ({ id: row.id, providerID: row.providerID }));
    },

    async list() {
      await seedIfEmpty();
      const rows = await col().find().toArray();
      const rank = (role?: ModelRole) => (role === 'default' ? 0 : role === 'backup' ? 1 : 2);
      return rows.sort(
        (a, b) => rank(a.role) - rank(b.role) || (a.created_at?.getTime() ?? 0) - (b.created_at?.getTime() ?? 0)
      );
    },

    async update(modelId, patch) {
      await seedIfEmpty();
      const set: Record<string, unknown> = {};
      if (patch.enabled !== undefined) set.enabled = patch.enabled;
      if (patch.role !== undefined) set.role = patch.role; // null clears it
      if (Object.keys(set).length === 0) return null;
      set.updated_at = new Date();

      const result = await col().findOneAndUpdate(
        { id: modelId },
        { $set: set },
        { returnDocument: 'after' }
      );
      return result;
    },

    async add(config) {
      await seedIfEmpty();
      const existing = await col().findOne({ id: config.id });
      if (existing) return null;
      const doc: ModelConfig = {
        id: config.id,
        providerID: config.providerID,
        enabled: true,
        created_at: new Date(),
      };
      const { insertedId } = await col().insertOne(doc);
      return (await col().findOne({ _id: insertedId }))!;
    },
  };
}
