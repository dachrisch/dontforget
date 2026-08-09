import { randomBytes } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import type { EmailSender } from '../email/EmailSender';

const TOKEN_TTL_MS = 15 * 60 * 1000;

export class MagicLinkService {
  constructor(
    private db: Db,
    private emailSender: EmailSender,
    private baseUrl: string
  ) {}

  async requestLink(email: string): Promise<void> {
    const users = this.db.collection<{ _id: ObjectId }>('users');
    await users.updateOne({ email }, { $setOnInsert: { email } }, { upsert: true });

    const user = await users.findOne({ email });
    const userId = user!._id.toString();

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
    await this.db.collection('magic_links').insertOne({
      user_id: userId,
      token,
      expires_at: expiresAt,
      used_at: null,
    });

    const link = `${this.baseUrl}/api/auth/callback?token=${token}`;
    await this.emailSender.send(email, 'Your dontforget sign-in link', `Sign in: ${link}`);
  }

  async verifyToken(token: string): Promise<string | null> {
    const result = await this.db.collection('magic_links').findOneAndUpdate(
      { token, used_at: null, expires_at: { $gt: new Date() } },
      { $set: { used_at: new Date() } }
    );
    return result ? (result.user_id as string) : null;
  }
}