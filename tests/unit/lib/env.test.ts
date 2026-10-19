import { describe, expect, it } from 'vitest';
import { getEnv } from '@/lib/env';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/d',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  PRICING_TOKEN_SECRET: 'b'.repeat(32),
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'b',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  MAIL_FROM: 'DOPAMEAN <no-reply@localhost>',
} as unknown as NodeJS.ProcessEnv;

describe('env validation (Zod at the boundary)', () => {
  it('accepts a valid environment and applies defaults', () => {
    const env = getEnv(valid);
    expect(env.SMTP_PORT).toBe(1025);
    expect(env.RESERVATION_TTL_MINUTES).toBe(15);
    expect(env.ORDER_PAYMENT_DEADLINE_MINUTES).toBe(60);
  });

  it('lists every invalid variable in one error', () => {
    expect(() => getEnv({ ...valid, DATABASE_URL: '', BETTER_AUTH_SECRET: 'short' })).toThrow(
      /DATABASE_URL[\s\S]*BETTER_AUTH_SECRET/,
    );
  });

  it('rejects secrets shorter than 32 characters', () => {
    expect(() => getEnv({ ...valid, PRICING_TOKEN_SECRET: 'x'.repeat(31) })).toThrow(
      /PRICING_TOKEN_SECRET/,
    );
  });
});
