import type { Db } from 'mongodb';

// Series identity (issue #143 follow-up): every series records what it
// applies to — the canonical recurring entity (e.g. "Auer Dult, Munich",
// "Stadtfest Minden, Minden"). Rows written before this migration only have
// a title, so backfill applies_to from the title; the normalized_title index
// already dedupes on that same identity.
export async function migrate(db: Db): Promise<void> {
  await db.collection('series').updateMany(
    { $or: [{ applies_to: { $exists: false } }, { applies_to: '' }] },
    [{ $set: { applies_to: '$title' } }]
  );
}
