import type { DbOrTx } from '@/db/client';
import { auditFilterOptions, searchAudit, type AuditSearch } from '@/modules/audit';
import { assertCan, type AdminActor } from '@/modules/staff';

/** Audit log search (permission audit.view: owner and manager). The log itself is append-only. */
export async function searchAuditAdmin(db: DbOrTx, actor: AdminActor, filter: AuditSearch) {
  assertCan(actor, 'audit.view');
  return searchAudit(db, filter);
}

export async function auditFilterOptionsAdmin(db: DbOrTx, actor: AdminActor) {
  assertCan(actor, 'audit.view');
  return auditFilterOptions(db);
}
