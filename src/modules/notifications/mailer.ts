import nodemailer from 'nodemailer';
import type { EmailMessage } from './domain/templates';

/** Small interface so the provider can be swapped (SES, Resend, SMTP). */
export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

export type SmtpConfig = {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  secure?: boolean;
  from: string;
};

export function createSmtpMailer(cfg: SmtpConfig): Mailer {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure ?? false,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  return {
    async send(m) {
      await transport.sendMail({
        from: cfg.from,
        to: m.to,
        subject: m.subject,
        text: m.text,
        html: m.html,
      });
    },
  };
}
