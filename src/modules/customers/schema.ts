import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from '@/db/auth-schema';

export const customerProfile = pgTable('customer_profile', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  phone: text('phone'),
  marketingOptIn: boolean('marketing_opt_in').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const address = pgTable(
  'address',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customerProfile.userId, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city').notNull(),
    /** GST state code, e.g. "06" for Haryana. Decides CGST+SGST vs IGST. */
    stateCode: text('state_code').notNull(),
    pincode: text('pincode').notNull(),
    phone: text('phone').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('address_customer_idx').on(t.customerId)],
);
