import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc } from "better-auth/plugins/admin/access";

export const statement = {
  ...defaultStatements,
  project: ["create", "share", "update", "delete"],
} as const;

export const ac = createAccessControl(statement);

export const superadmin = ac.newRole({
  project: ["create", "update"],
  ...adminAc.statements,
});

export const admin = ac.newRole({
  project: ["create", "update"],
  ...adminAc.statements,
});

export const manager = ac.newRole({}) as any;

// export const subadmin = ac.newRole({}) as any;

export const support = ac.newRole({}) as any;

// Store owners — scoped to just creating their own staff (via /api/auth/admin/create-user).
// Deliberately NOT granted list/ban/impersonate/delete/set-role: those better-auth admin
// endpoints operate across all users platform-wide with no store scoping, unlike our own
// /api/staff routes which scope by storeOwnerId.
export const owner = ac.newRole({ user: ["create"] }) as any;
