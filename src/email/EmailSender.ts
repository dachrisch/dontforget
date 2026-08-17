export interface EmailSender {
  send(to: string, subject: string, body: string, html?: string): Promise<void>;
}

export class CapturingEmailSender implements EmailSender {
  sent: { to: string; subject: string; body: string; html?: string }[] = [];

  async send(to: string, subject: string, body: string, html?: string): Promise<void> {
    this.sent.push({ to, subject, body, html });
  }
}

export class ConsoleEmailSender implements EmailSender {
  async send(to: string, subject: string, body: string, html?: string): Promise<void> {
    console.log(`\n--- email to ${to} ---\n${subject}\n${body}\n---\n`);
    if (html) console.log(`(HTML version available, ${html.length} bytes)`);
  }
}

export interface MailTransporter {
  sendMail(options: { from: string; to: string; subject: string; text: string; html?: string }): Promise<unknown>;
}

export class SmtpEmailSender implements EmailSender {
  constructor(
    private transporter: MailTransporter,
    private from: string
  ) {}

  async send(to: string, subject: string, body: string, html?: string): Promise<void> {
    const opts: { from: string; to: string; subject: string; text: string; html?: string } = {
      from: this.from, to, subject, text: body,
    };
    if (html) opts.html = html;
    await this.transporter.sendMail(opts);
  }
}