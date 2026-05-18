"use strict";
// Fine-grained permission strings. Applied as overrides on top of a user's role.
// Format: "<resource>:<action>" — e.g. "orders:write"
//
// The RolesGuard resolves access in this order:
//   1. PLATFORM_ADMIN bypasses all checks
//   2. Role-level permissions (via ROLE_PERMISSIONS map below)
//   3. User-level permission overrides (additive OR subtractive with "!" prefix)
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROLE_PERMISSIONS = exports.PERMISSIONS = void 0;
exports.PERMISSIONS = {
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
};
// What each role can do by default — no DB lookup required for common checks.
// PLATFORM_ADMIN is not listed because it bypasses the permission system entirely.
exports.ROLE_PERMISSIONS = {
    TENANT_OWNER: Object.values(exports.PERMISSIONS).flatMap((g) => Object.values(g)),
    MANAGER: [
        exports.PERMISSIONS.ORDERS.READ,
        exports.PERMISSIONS.ORDERS.WRITE,
        exports.PERMISSIONS.ORDERS.CANCEL,
        exports.PERMISSIONS.MENUS.READ,
        exports.PERMISSIONS.MENUS.WRITE,
        exports.PERMISSIONS.MENUS.PUBLISH,
        exports.PERMISSIONS.LOCATIONS.READ,
        exports.PERMISSIONS.LOCATIONS.WRITE,
        exports.PERMISSIONS.INTEGRATIONS.READ,
        exports.PERMISSIONS.ANALYTICS.READ,
        exports.PERMISSIONS.ANALYTICS.EXPORT,
        exports.PERMISSIONS.USERS.READ,
        exports.PERMISSIONS.USERS.INVITE,
        exports.PERMISSIONS.KDS.VIEW,
        exports.PERMISSIONS.KDS.OPERATE,
        exports.PERMISSIONS.DISPATCH.VIEW,
        exports.PERMISSIONS.DISPATCH.MANAGE,
    ],
    CASHIER: [
        exports.PERMISSIONS.ORDERS.READ,
        exports.PERMISSIONS.ORDERS.WRITE,
        exports.PERMISSIONS.MENUS.READ,
        exports.PERMISSIONS.KDS.VIEW,
    ],
    KITCHEN_STAFF: [
        exports.PERMISSIONS.ORDERS.READ,
        exports.PERMISSIONS.KDS.VIEW,
        exports.PERMISSIONS.KDS.OPERATE,
    ],
    DRIVER: [exports.PERMISSIONS.DISPATCH.VIEW, exports.PERMISSIONS.ORDERS.READ],
    VIEWER: [
        exports.PERMISSIONS.ORDERS.READ,
        exports.PERMISSIONS.MENUS.READ,
        exports.PERMISSIONS.ANALYTICS.READ,
    ],
};
//# sourceMappingURL=permissions.js.map