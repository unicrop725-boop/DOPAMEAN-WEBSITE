import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Transactional outbox: written in the same transaction as the business change, relayed by the worker. */
export const outboxEvent = pgTable(
  'outbox_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aggregate: text('aggregate').notNull(),
    aggregateId: text('aggregate_id'),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    relayedAt: timestamp('relayed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('outbox_pending_idx')
      .on(t.availableAt)
      .where(sql`relayed_at IS NULL`),
  ],
);

/** Idempotency keys for state-changing requests (INV-06). */
export const idempotencyKey = pgTable(
  'idempotency_key',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('idempotency_scope_key_uq').on(t.scope, t.key)],
);

/** Worker liveness, read by /api/health. */
export const workerHeartbeat = pgTable('worker_heartbeat', {
  name: text('name').primaryKey(),
  beatAt: timestamp('beat_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Editable storefront content pages (FAQ, shipping, legal ...). Body is plain text, rendered safely. */
export const contentPage = pgTable('content_page', {
  slug: text('slug').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  published: boolean('published').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Messages from the public contact form. */
export const contactMessage = pgTable('contact_message', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  message: text('message').notNull(),
  ip: text('ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  handledAt: timestamp('handled_at', { withTimezone: true }),
});

/** Fixed-window counters for application rate limits (contact form, coupon apply, checkout ...). */
export const appRateLimit = pgTable(
  'app_rate_limit',
  {
    key: text('key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

/** Newsletter / "wishlist me" sign-ups from the footer form. One row per email address. */
export const newsletterSubscriber = pgTable(
  'newsletter_subscriber',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firstName: text('first_name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('newsletter_email_uq').on(t.email)],
);
