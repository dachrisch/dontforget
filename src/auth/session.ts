import { randomBytes } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { UserRow } from './magicLink.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'df_session';

interface SessionRow {
  _id: string;
  user_id: string;
  expires_at: Date;
}

export class SessionService {
  constructor(private db: Db) {}

  async createSession(userId: string): Promise<string> {
    const id = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.db.collection<SessionRow>('sessions').insertOne({
      _id: id,
      user_id: userId,
      expires_at: expiresAt,
    });
    return id;
  }

  async getUserId(sessionId: string): Promise<string | null> {
    const result = await this.db
      .collection<SessionRow>('sessions')
      .findOne({ _id: sessionId, expires_at: { $gt: new Date() } });
    return result ? result.user_id : null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.collection<SessionRow>('sessions').deleteOne({ _id: sessionId });
  }

  // Resolves the user behind a session's userId, or null if the id no longer
  // points at a real user (deleted account, malformed id).
  async getUser(userId: string): Promise<UserRow | null> {
    if (!ObjectId.isValid(userId)) return null;
    return this.db.collection<UserRow>('users').findOne({ _id: new ObjectId(userId) });
  }
}

export function createRequireAuth(sessionService: SessionService): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = request.cookies?.[SESSION_COOKIE];
    const userId = sessionId ? await sessionService.getUserId(sessionId) : null;
    if (!userId) {
      reply.code(401).send({ error: 'unauthenticated' });
      return reply;
    }
    request.userId = userId;
  };
}

export function createRequireAdmin(sessionService: SessionService): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = request.cookies?.[SESSION_COOKIE];
    const userId = sessionId ? await sessionService.getUserId(sessionId) : null;
    if (!userId) {
      reply.code(401).send({ error: 'unauthenticated' });
      return reply;
    }
    const user = await sessionService.getUser(userId);
    if (!user || user.role !== 'admin') {
      reply.code(403).send({ error: 'forbidden' });
      return reply;
    }
    request.userId = userId;
  };
}

export { SESSION_COOKIE };