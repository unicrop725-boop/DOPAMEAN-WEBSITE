import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const taxRuleKind = pgEnum('tax_rule_kind', ['fixed', 'slab']);

/**
 * GST rule. `fixed`: always rate_bp. `slab`: rate_bp up to and including slab_threshold_paise per unit,
 * rate_bp_above for anything higher (apparel rates are price-slab based; see SPEC §4.3, Q3).
 */
export const taxRule = pgTable(
  'tax_rule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: taxRuleKind('kind').notNull(),
    rateBp: integer('rate_bp').notNull(),
    slabThresholdPaise: bigint('slab_threshold_paise', { mode: 'number' }),
    rateBpAbove: integer('rate_bp_above'),
  },
  (t) => [
    check('tax_rule_rate_range', sql`${t.rateBp} >= 0 AND ${t.rateBp} <= 10000`),
    check(
      'tax_rule_slab_complete',
      sql`${t.kind} = 'fixed' OR (${t.slabThresholdPaise} IS NOT NULL AND ${t.rateBpAbove} IS NOT NULL)`,
    ),
  ],
);
