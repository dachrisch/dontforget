import type { Db } from 'mongodb';

// The default extraction model moved to "glm-5.3-flash" on the "opencode-go"
// provider (OpenCode Go) on 2026-09-01. Existing deployments already seeded
// "qwen3.7-flash" (bailian-payg) into the `models` registry as the default
// (and the unique `id` index prevents re-seeding), so they would keep using
// the old model. This migration swaps any seeded qwen3.7-flash doc for the
// new default, preserving each doc's role/enabled/created_at. If glm-5.3-flash
// is already configured, the old doc is dropped rather than clobbering the
// admin's config.
const SWAPS = [{ from: 'qwen3.7-flash', to: { id: 'glm-5.3-flash', providerID: 'opencode-go' } }];

export async function migrate(db: Db): Promise<void> {
  const col = db.collection('models');
  for (const { from, to } of SWAPS) {
    const old = await col.findOne({ id: from });
    if (!old) continue;

    const target = await col.findOne({ id: to.id });
    if (target) {
      await col.deleteOne({ _id: old._id });
      continue;
    }

    await col.updateOne(
      { _id: old._id },
      { $set: { id: to.id, providerID: to.providerID, updated_at: new Date() } }
    );
  }
}
