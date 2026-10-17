import { inArray } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { taxRule } from './schema';
import type { TaxRule } from './domain/gst';

export { rateForUnit, extractTax, splitGst, computeLineTax } from './domain/gst';
export type { TaxRule, GstSplit, LineTax } from './domain/gst';

/** Default apparel rule used by the seed: 5% up to Rs 2,500 per unit, 18% above (confirm with the accountant). */
export const DEFAULT_APPAREL_RULE = {
  name: 'Apparel GST (price slab)',
  kind: 'slab' as const,
  rateBp: 500,
  slabThresholdPaise: 250_000,
  rateBpAbove: 1800,
};

export async function createTaxRule(
  tx: DbOrTx,
  input: {
    name: string;
    kind: 'fixed' | 'slab';
    rateBp: number;
    slabThresholdPaise?: number;
    rateBpAbove?: number;
  },
): Promise<string> {
  const [row] = await tx.insert(taxRule).values(input).returning({ id: taxRule.id });
  if (!row) throw new Error('tax rule insert failed');
  return row.id;
}

/** Load rules by id as pure TaxRule values (a missing id simply has no entry: treated as 0%). */
export async function loadTaxRules(db: DbOrTx, ids: string[]): Promise<Map<string, TaxRule>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, TaxRule>();
  if (unique.length === 0) return out;
  const rows = await db.select().from(taxRule).where(inArray(taxRule.id, unique));
  for (const r of rows) {
    out.set(
      r.id,
      r.kind === 'fixed'
        ? { kind: 'fixed', rateBp: r.rateBp }
        : {
            kind: 'slab',
            rateBp: r.rateBp,
            thresholdPaise: Number(r.slabThresholdPaise),
            rateBpAbove: Number(r.rateBpAbove),
          },
    );
  }
  return out;
}

export async function listTaxRules(db: DbOrTx) {
  return db.select().from(taxRule);
}
