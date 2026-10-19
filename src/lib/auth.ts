import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { twoFactor } from 'better-auth/plugins';
import { getDb } from '@/db/client';
import * as authSchema from '@/db/auth-schema';
import { getEnv } from '@/lib/env';
import { ensureCustomerProfile } from '@/modules/customers';
import { enqueueEmail, resetPasswordMessage, verifyEmailMessage } from '@/modules/notifications';

/**
 * Better Auth instance (brief §4): email + password, email verification, database sessions,
 * TOTP 2FA available (required for Owner/Manager by the admin guard, not here).
 * Public sign-up always creates a customer. Staff users are created only by an Owner (staff module).
 */
function createAuth() {
  const env = getEnv();
  const db = getDb();
  return betterAuth({
    appName: 'DOPAMEAN',
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async ({ user, url }) => {
        await enqueueEmail(db, resetPasswordMessage(user.email, user.name, url));
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }) => {
        await enqueueEmail(db, verifyEmailMessage(user.email, user.name, url));
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: env.NODE_ENV === 'production',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 15 * 60, max: 10 },
        '/sign-up/email': { window: 60 * 60, max: 5 },
        '/request-password-reset': { window: 60 * 60, max: 5 },
        '/forget-password': { window: 60 * 60, max: 5 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Public sign-up always yields a customer. Staff rows are created only by the staff module.
          after: async (created) => {
            await ensureCustomerProfile(db, created.id);
          },
        },
      },
    },
    plugins: [twoFactor({ issuer: 'DOPAMEAN' }), nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}
