// Fine-grained permission strings. Applied as overrides on top of a user's role.
// Format: "<resource>:<action>" — e.g. "orders:write"
//
// The RolesGuard resolves access in this order:
//   1. PLATFORM_ADMIN bypasses all checks
//   2. Role-level permissions (via ROLE_PERMISSIONS map below)
//   3. User-level permission overrides (additive OR subtractive with "!" prefix)

export const PERMISSIONS = {
  ORDERS: {
    READ: "orders:read",
    WRITE: "orders:write",
    CANCEL: "orders:cancel",
    REFUND: "orders:refund",
  },
  MENUS: {
    READ: "menus:read",
    WRITE: "menus:write",
    PUBLISH: "menus:publish",
  },
  LOCATIONS: {
    READ: "locations:read",
    WRITE: "locations:write",
    MANAGE: "locations:manage",
  },
  INTEGRATIONS: {
    READ: "integrations:read",
    MANAGE: "integrations:manage",
  },
  ANALYTICS: {
    READ: "analytics:read",
    EXPORT: "analytics:export",
  },
  USERS: {
    READ: "users:read",
    INVITE: "users:invite",
    MANAGE: "users:manage",
  },
  BILLING: {
    READ: "billing:read",
    MANAGE: "billing:manage",
  },
  KDS: {
    VIEW: "kds:view",
    OPERATE: "kds:operate",
  },
  DISPATCH: {
    VIEW: "dispatch:view",
    MANAGE: "dispatch:manage",
  },
} as const;

// Distributive helper: extracts values from a Record type, distributing over unions
type PermissionValues<T> = T extends Record<string, infer V> ? V : never;
export type Permission = PermissionValues<PermissionValues<typeof PERMISSIONS>>;

// What each role can do by default — no DB lookup required for common checks.
// PLATFORM_ADMIN is not listed because it bypasses the permission system entirely.
export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  TENANT_OWNER: Object.values(PERMISSIONS).flatMap((g) =>
    Object.values(g),
  ) as Permission[],
  MANAGER: [
    PERMISSIONS.ORDERS.READ,
    PERMISSIONS.ORDERS.WRITE,
    PERMISSIONS.ORDERS.CANCEL,
    PERMISSIONS.MENUS.READ,
    PERMISSIONS.MENUS.WRITE,
    PERMISSIONS.MENUS.PUBLISH,
    PERMISSIONS.LOCATIONS.READ,
    PERMISSIONS.LOCATIONS.WRITE,
    PERMISSIONS.INTEGRATIONS.READ,
    PERMISSIONS.ANALYTICS.READ,
    PERMISSIONS.ANALYTICS.EXPORT,
    PERMISSIONS.USERS.READ,
    PERMISSIONS.USERS.INVITE,
    PERMISSIONS.KDS.VIEW,
    PERMISSIONS.KDS.OPERATE,
    PERMISSIONS.DISPATCH.VIEW,
    PERMISSIONS.DISPATCH.MANAGE,
  ],
  CASHIER: [
    PERMISSIONS.ORDERS.READ,
    PERMISSIONS.ORDERS.WRITE,
    PERMISSIONS.MENUS.READ,
    PERMISSIONS.KDS.VIEW,
  ],
  KITCHEN_STAFF: [
    PERMISSIONS.ORDERS.READ,
    PERMISSIONS.KDS.VIEW,
    PERMISSIONS.KDS.OPERATE,
  ],
  DRIVER: [PERMISSIONS.DISPATCH.VIEW, PERMISSIONS.ORDERS.READ],
  // ── Device accounts ─────────────────────────────────────────────────────
  // Not people. Each drives one unattended screen, so each gets the smallest
  // set that screen needs and nothing that would be useful to a passer-by.
  // A kiosk writes orders but must never read the order book; a kitchen
  // display reads and bumps tickets but must never create an order.
  KIOSK: [PERMISSIONS.MENUS.READ, PERMISSIONS.ORDERS.WRITE],
  KITCHEN_DISPLAY: [PERMISSIONS.KDS.VIEW, PERMISSIONS.KDS.OPERATE],
  VIEWER: [
    PERMISSIONS.ORDERS.READ,
    PERMISSIONS.MENUS.READ,
    PERMISSIONS.ANALYTICS.READ,
  ],
};
