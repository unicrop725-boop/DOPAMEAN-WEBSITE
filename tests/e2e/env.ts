import { randomBytes } from 'node:crypto';

/** Environment shared by the E2E global setup and the specs. */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_DB = 'dopamean_e2e';
export const PG_ADMIN_URL =
  process.env.E2E_PG_ADMIN_URL ?? 'postgres://dopamean:dopamean@localhost:5432/postgres';
export const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';

export const OWNER = {
  email: 'owner@example.test',
  name: 'E2E Owner',
  password: 'correct-horse-battery-staple',
};

export function dbUrl(): string {
  const u = new URL(PG_ADMIN_URL);
  u.pathname = `/${E2E_DB}`;
  return u.toString();
}

// Fresh random secrets per run: nothing secret-looking is committed.
const RUN_SECRETS = {
  auth: randomBytes(32).toString('hex'),
  pricing: randomBytes(32).toString('hex'),
};

export function appEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: dbUrl(),
    APP_URL: `http://localhost:${E2E_PORT}`,
    BETTER_AUTH_SECRET: RUN_SECRETS.auth,
    PRICING_TOKEN_SECRET: RUN_SECRETS.pricing,
    S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    S3_BUCKET: 'dopamean-e2e',
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'minioadmin',
    S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'minioadmin',
    SMTP_HOST: process.env.SMTP_HOST ?? 'localhost',
    SMTP_PORT: process.env.SMTP_PORT ?? '1025',
    MAIL_FROM: 'DOPAMEAN <no-reply@localhost>',
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
    NODE_ENV: 'production',
  };
}
