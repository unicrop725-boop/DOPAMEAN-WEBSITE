export { can, requiresTwoFactor, ROLES, PERMISSIONS } from './domain/roles';
export type { Role, Permission } from './domain/roles';
export { loadStaff, assertCan, createStaff, bootstrapOwner } from './service';
export type { StaffContext, CreateStaffInput } from './service';
