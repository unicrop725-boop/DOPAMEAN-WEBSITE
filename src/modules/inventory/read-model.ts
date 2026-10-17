import { sql, type SQL } from 'drizzle-orm';

/**
 * Public read-model fragment so other modules (catalog listings) can ask "how many can be sold?"
 * inside their own SQL without reading this module's tables directly (brief §5).
 * `variantIdExpr` is a SQL expression that yields a variant id, e.g. sql`v.id`.
 */
export function availableQtySql(variantIdExpr: SQL): SQL {
  return sql`COALESCE((SELECT il.on_hand - il.reserved FROM inventory_level il WHERE il.variant_id = ${variantIdExpr}), 0)`;
}

const levelColumn = (column: string, variantIdExpr: SQL): SQL =>
  sql`COALESCE((SELECT ${sql.raw(`il.${column}`)} FROM inventory_level il WHERE il.variant_id = ${variantIdExpr}), 0)`;

/** Stock columns as scalar SQL expressions for admin lists in other modules (same idea as availableQtySql). */
export const onHandQtySql = (variantIdExpr: SQL): SQL => levelColumn('on_hand', variantIdExpr);
export const reservedQtySql = (variantIdExpr: SQL): SQL => levelColumn('reserved', variantIdExpr);
export const lowStockThresholdSql = (variantIdExpr: SQL): SQL =>
  levelColumn('low_stock_threshold', variantIdExpr);
