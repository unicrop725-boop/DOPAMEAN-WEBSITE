export { initStock, adjustStock, getAvailable, countLowStock, purgeStock } from './stock';
export type { StockChange } from './stock';

export { availableQtySql, onHandQtySql, reservedQtySql, lowStockThresholdSql } from './read-model';
export {
  reserveStock,
  commitReservations,
  releaseReservations,
  restockSold,
  expireDueReservations,
  listReservations,
} from './reservations';
export type { ReserveItem } from './reservations';

export { adjustStockAdmin, setLowStockThresholdAdmin, listMovementsAdmin } from './admin';
export type { AdjustStockInput } from './admin';
