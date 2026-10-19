import { z } from 'zod';
import { enqueueOutbox, type OutboxHandlers } from '@/lib/outbox';
import type { DbOrTx } from '@/db/client';
import { createSmtpMailer, type Mailer } from './mailer';
import type { EmailMessage } from './domain/templates';

export { verifyEmailMessage, resetPasswordMessage, staffInviteMessage } from './domain/templates';
export type { EmailMessage } from './domain/templates';
export type { Mailer } from './mailer';
export { createSmtpMailer } from './mailer';

export const EMAIL_SEND = 'email.send';

const emailPayload = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  text: z.string().min(1),
  html: z.string().optional(),
});

/** Queue an email through the outbox. Pass the business transaction so the email commits with it. */
export function enqueueEmail(tx: DbOrTx, message: EmailMessage): Promise<string> {
  const payload = emailPayload.parse(message);
  return enqueueOutbox(tx, { aggregate: 'email', type: EMAIL_SEND, payload });
}

/** Outbox handlers owned by this module; registered by the worker. */
export function notificationHandlers(mailer: Mailer): OutboxHandlers {
  return {
    [EMAIL_SEND]: async (payload) => {
      await mailer.send(emailPayload.parse(payload));
    },
  };
}

export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
  return createSmtpMailer({
    host: env.SMTP_HOST ?? 'localhost',
    port: Number(env.SMTP_PORT ?? 1025),
    user: env.SMTP_USER || undefined,
    pass: env.SMTP_PASS || undefined,
    secure: env.SMTP_SECURE === 'true',
    from: env.MAIL_FROM ?? 'DOPAMEAN <no-reply@localhost>',
  });
}
