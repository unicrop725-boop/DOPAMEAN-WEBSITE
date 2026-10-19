import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/** Treat an empty string (an unset line in .env) as undefined. */
function emptyToUndefined<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), inner);
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 chars'),
  PRICING_TOKEN_SECRET: z.string().min(32, 'PRICING_TOKEN_SECRET must be at least 32 chars'),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().min(3),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RESERVATION_TTL_MINUTES: z.coerce.number().int().min(1).default(15),
  ORDER_PAYMENT_DEADLINE_MINUTES: z.coerce.number().int().min(1).default(60),
  SENTRY_DSN: z.string().optional(),
  CONTACT_INBOX: emptyToUndefined(z.string().email().optional()),
  S3_PUBLIC_URL: emptyToUndefined(z.url().optional()),
  SMTP_SECURE: bool,
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parse and validate process.env once. Throws a readable error listing every bad variable. */
export function getEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source === process.env && cached) return cached;
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  if (source === process.env) cached = result.data;
  return result.data;
}
