import { boolean, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from '@/db/auth-schema';

export const staffRole = pgEnum('staff_role', ['owner', 'manager', 'support']);

/** A user with a row here is staff. Rows are created only by an Owner (or the bootstrap CLI). */
export const staffProfile = pgTable('staff_profile', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  role: staffRole('role').notNull(),
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
