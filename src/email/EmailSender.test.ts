import { describe, it, expect, vi } from 'vitest';
import { CapturingEmailSender, SmtpEmailSender, type MailTransporter } from './EmailSender';

describe('CapturingEmailSender', () => {
  it('records sent emails without sending anything', async () => {
    const sender = new CapturingEmailSender();
    await sender.send('a@example.com', 'Subject', 'Body');
    expect(sender.sent).toEqual([{ to: 'a@example.com', subject: 'Subject', body: 'Body' }]);
  });
});

describe('SmtpEmailSender', () => {
  it('delegates to the transporter with the configured from address', async () => {
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const transporter: MailTransporter = { sendMail };
    const sender = new SmtpEmailSender(transporter, 'dontforget@lehel.xyz');

    await sender.send('a@example.com', 'Subject', 'Body');

    expect(sendMail).toHaveBeenCalledWith({
      from: 'dontforget@lehel.xyz',
      to: 'a@example.com',
      subject: 'Subject',
      text: 'Body',
    });
  });
});