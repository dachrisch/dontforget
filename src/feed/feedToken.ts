import { randomBytes } from 'node:crypto';
import type { Db } from 'mongodb';

export async function getOrCreateFeedToken(db: Db, userId: string): Promise<string> {
  const existing = await db.collection('feed_tokens').findOne({ user_id: userId });
  if (existing) {
    return existing.token as string;
  }

  const token = randomBytes(24).toString('hex');
  try {
    await db.collection('feed_tokens').insertOne({ user_id: userId, token });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    const concurrent = await db.collection('feed_tokens').findOne({ user_id: userId });
    if (concurrent) return concurrent.token as string;
    throw err;
  }
  return token;
}

export async function rotateFeedToken(db: Db, userId: string): Promise<string> {
  const token = randomBytes(24).toString('hex');
  const result = await db
    .collection<{ user_id: string; token: string }>('feed_tokens')
    .findOneAndUpdate({ user_id: userId }, { $set: { token } }, { returnDocument: 'after', upsert: true });
  return result!.token;
}