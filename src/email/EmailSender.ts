export interface EmailSender {
  send(to: string, subject: string, body: string): Promise<void>;
}

export class CapturingEmailSender implements EmailSender {
  sent: { to: string; subject: string; body: string }[] = [];

  async send(to: string, subject: string, body: string): Promise<void> {
    this.sent.push({ to, subject, body });
  }
}

export class ConsoleEmailSender implements EmailSender {
  async send(to: string, subject: string, body: string): Promise<void> {
    console.log(`\n--- email to ${to} ---\n${subject}\n${body}\n---\n`);
  }
}

export interface MailTransporter {
  sendMail(options: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export class SmtpEmailSender implements EmailSender {
  constructor(
    private transporter: MailTransporter,
    private from: string
  ) {}

  async send(to: string, subject: string, body: string): Promise<void> {
    await this.transporter.sendMail({ from: this.from, to, subject, text: body });
  }
}