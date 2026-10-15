/**
 * Roles a store-level staff manager (owner/subadmin/manager) may assign to
 * their own store's staff via /api/staff or the Create Staff page.
 */
export const STORE_STAFF_ROLES = ["manager", "support", "subadmin", "marketing"] as const;

/**
 * Platform-level roles. Only a superadmin may assign these — "admin" grants
 * better-auth's adminRoles privileges (see lib/auth.ts), so handing it out
 * from a store-scoped flow would be a privilege escalation. "it_support" and
 * "project_manager" are platform staff like "admin" but without adminAc
 * privileges — they're listed here only so Create Platform Admin stays
 * superadmin-gated, not because they grant admin access.
 */
export const PLATFORM_STAFF_ROLES = ["admin", "it_support", "project_manager"] as const;

export const ASSIGNABLE_STAFF_ROLES = [
  ...STORE_STAFF_ROLES,
  ...PLATFORM_STAFF_ROLES,
] as const;

export type AssignableStaffRole = (typeof ASSIGNABLE_STAFF_ROLES)[number];
