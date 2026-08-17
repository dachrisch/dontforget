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
      .send(email, 'Your dontforget sign-in link', `Sign in: ${link}`, magicLinkHtml(link))
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

function magicLinkHtml(link: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sign in to dontforget</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:40px 20px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
  <tr><td style="padding:32px 32px 16px;">
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#1a1a2e;">dontforget</h1>
    <p style="margin:0;font-size:15px;color:#555;line-height:1.5;">Sign in to your account</p>
  </td></tr>
  <tr><td style="padding:0 32px 32px;">
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
    <tr><td style="padding:24px 0;">
      <a href="${link}" style="display:block;background-color:#2563eb;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;text-align:center;padding:14px 24px;border-radius:8px;">Sign in to dontforget</a>
    </td></tr>
    </table>
    <p style="margin:0 0 4px;font-size:14px;color:#666;line-height:1.5;">Or copy this link:<br><span style="word-break:break-all;font-size:13px;color:#2563eb;">${link}</span></p>
  </td></tr>
  <tr><td style="padding:16px 32px;background-color:#f9fafb;border-top:1px solid #eee;">
    <p style="margin:0;font-size:13px;color:#888;line-height:1.5;">This link expires in 15 minutes and can only be used once. If you didn't request this, you can safely ignore this email.</p>
  </td></tr>
</table>
<p style="margin:24px 0 0;font-size:12px;color:#999;">dontforget &mdash; recurring event reminders</p>
</td></tr>
</table>
</body>
</html>`;
}