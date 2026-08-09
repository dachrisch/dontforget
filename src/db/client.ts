import { MongoClient } from 'mongodb';

export async function createClient(connectionString: string): Promise<MongoClient> {
  const client = new MongoClient(connectionString);
  await client.connect();
  return client;
}