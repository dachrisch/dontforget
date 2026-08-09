import type { Db } from 'mongodb';

export async function migrate(db: Db): Promise<void> {
  await db.createCollection('users');
  await db.collection('users').createIndex({ email: 1 }, { unique: true });

  await db.createCollection('magic_links');
  await db.collection('magic_links').createIndex({ token: 1 }, { unique: true });
  await db.collection('magic_links').createIndex({ user_id: 1 });
  await db.collection('magic_links').createIndex({ expires_at: 1 });

  await db.createCollection('sessions');
  await db.collection('sessions').createIndex({ user_id: 1 });
  await db.collection('sessions').createIndex({ expires_at: 1 });

  await db.createCollection('queries');
  await db.collection('queries').createIndex({ user_id: 1 });

  await db.createCollection('events');
  await db.collection('events').createIndex({ query_id: 1 });

  await db.createCollection('feed_tokens');
  await db.collection('feed_tokens').createIndex({ user_id: 1 }, { unique: true });
  await db.collection('feed_tokens').createIndex({ token: 1 }, { unique: true });
}