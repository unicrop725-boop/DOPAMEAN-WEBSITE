import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, can, requiresTwoFactor, type Permission } from '@/modules/staff';

describe('role permission matrix (SPEC §8.3)', () => {
  it('owner has every permission', () => {
    for (const p of PERMISSIONS) expect(can('owner', p)).toBe(true);
  });

  it('support cannot refund, cancel, ship, edit catalog or manage staff', () => {
    const denied: Permission[] = [
      'orders.refund',
      'orders.cancel',
      'orders.ship',
      'catalog.edit',
      'inventory.edit',
      'coupons.edit',
      'staff.manage',
      'settings.manage',
      'audit.view',
    ];
    for (const p of denied) expect(can('support', p), p).toBe(false);
    expect(can('support', 'orders.view')).toBe(true);
    expect(can('support', 'orders.note')).toBe(true);
  });

  it('manager can refund but cannot manage staff or settings', () => {
    expect(can('manager', 'orders.refund')).toBe(true);
    expect(can('manager', 'staff.manage')).toBe(false);
    expect(can('manager', 'settings.manage')).toBe(false);
  });

  it('2FA is required for owner and manager only', () => {
    expect(ROLES.filter(requiresTwoFactor)).toEqual(['owner', 'manager']);
  });
});
