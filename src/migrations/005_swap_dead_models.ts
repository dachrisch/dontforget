import type { Db } from 'mongodb';

// opencode retired its free models (mimo-v2.5-free, big-pickle) and renamed
// its providers on 2026-08-29. Existing deployments already seeded the old
// model ids into the `models` registry (and the unique `id` index prevents
// re-seeding), so they keep trying dead models until an admin edits them.
// This migration swaps any seeded dead models for the verified-working
// replacements, preserving each doc's role/enabled/created_at. If an admin
// has already configured the new id, the dead doc is dropped rather than
// clobbering their config.
const SWAPS = [
  { from: 'mimo-v2.5-free', to: { id: 'qwen3.7-flash', providerID: 'bailian-payg' } },
  { from: 'big-pickle', to: { id: 'antigravity-gemini-3-flash', providerID: 'google' } },
];

export async function migrate(db: Db): Promise<void> {
  const col = db.collection('models');
  for (const { from, to } of SWAPS) {
    const dead = await col.findOne({ id: from });
    if (!dead) continue;

    const target = await col.findOne({ id: to.id });
    if (target) {
      await col.deleteOne({ _id: dead._id });
      continue;
    }

    await col.updateOne(
      { _id: dead._id },
      { $set: { id: to.id, providerID: to.providerID, updated_at: new Date() } }
    );
  }
}
