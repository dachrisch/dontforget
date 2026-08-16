import { randomBytes } from 'node:crypto';
import { ObjectId, type Collection, type Db } from 'mongodb';
import type { EmailSender } from '../email/EmailSender.js';

const TOKEN_TTL_MS = 15 * 60 * 1000;
const DUPLICATE_KEY_ERROR_CODE = 11000;

interface UserRow {
  _id: ObjectId;
  email: string;
}

export class MagicLinkService {
  constructor(
    private db: Db,
    private emailSender: EmailSender,
    private baseUrl: string
  ) {}

  async requestLink(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const userId = await this.findOrCreateUserId(email);

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
    await this.db.collection('magic_links').insertOne({
      user_id: userId,
      token,
      expires_at: expiresAt,
      used_at: null,
    });

    const link = `${this.baseUrl}/api/auth/callback?token=${token}`;
    // Fire-and-forget: SMTP can be slow, and the sign-in response must not
    // wait for the mail to actually go out. The link row is already
    // persisted above, so a late/lost email only wastes a token, never
    // blocks the user.
    void this.emailSender
      .send(email, 'Your dontforget sign-in link', `Sign in: ${link}`)
      .catch(err => {
        console.error(`[dontforget] failed to send sign-in link to ${email}:`, err);
      });
  }

  private async findOrCreateUserId(email: string): Promise<string> {
    const users: Collection<UserRow> = this.db.collection<UserRow>('users');
    try {
      const result = await users.findOneAndUpdate(
        { email },
        { $setOnInsert: { email } },
        { upsert: true, returnDocument: 'after' }
      );
      return result!._id.toString();
    } catch (err) {
      // Two concurrent first-time requests for the same email can both miss
      // and both attempt the insert half of the upsert; one loses the unique
      // index race even with findOneAndUpdate. The other request already
      // created the user, so just look it up.
      if ((err as { code?: number }).code !== DUPLICATE_KEY_ERROR_CODE) throw err;
      const existing = await users.findOne({ email });
      return existing!._id.toString();
    }
  }

  async verifyToken(token: string): Promise<string | null> {
    const result = await this.db.collection('magic_links').findOneAndUpdate(
      { token, used_at: null, expires_at: { $gt: new Date() } },
      { $set: { used_at: new Date() } }
    );
    return result ? (result.user_id as string) : null;
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}