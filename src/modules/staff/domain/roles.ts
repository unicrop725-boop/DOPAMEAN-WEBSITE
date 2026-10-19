/** Role model and permission matrix (SPEC §8.3). Pure: no framework imports. */
export const ROLES = ['owner', 'manager', 'support'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'orders.view',
  'orders.note',
  'orders.ship',
  'orders.cancel',
  'orders.refund',
  'customers.view',
  'catalog.edit',
  'inventory.edit',
  'coupons.edit',
  'reports.view',
  'audit.view',
  'staff.manage',
  'settings.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  manager: new Set<Permission>([
    'orders.view',
    'orders.note',
    'orders.ship',
    'orders.cancel',
    'orders.refund',
    'customers.view',
    'catalog.edit',
    'inventory.edit',
    'coupons.edit',
    'reports.view',
    'audit.view',
  ]),
  support: new Set<Permission>(['orders.view', 'orders.note', 'customers.view']),
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].has(permission);
}

/** Owner and Manager must have TOTP 2FA enabled to use the admin (brief §4). */
export function requiresTwoFactor(role: Role): boolean {
  return role === 'owner' || role === 'manager';
}
