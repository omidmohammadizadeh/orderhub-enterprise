export declare const PERMISSIONS: {
    readonly ORDERS: {
        readonly READ: "orders:read";
        readonly WRITE: "orders:write";
        readonly CANCEL: "orders:cancel";
        readonly REFUND: "orders:refund";
    };
    readonly MENUS: {
        readonly READ: "menus:read";
        readonly WRITE: "menus:write";
        readonly PUBLISH: "menus:publish";
    };
    readonly LOCATIONS: {
        readonly READ: "locations:read";
        readonly WRITE: "locations:write";
        readonly MANAGE: "locations:manage";
    };
    readonly INTEGRATIONS: {
        readonly READ: "integrations:read";
        readonly MANAGE: "integrations:manage";
    };
    readonly ANALYTICS: {
        readonly READ: "analytics:read";
        readonly EXPORT: "analytics:export";
    };
    readonly USERS: {
        readonly READ: "users:read";
        readonly INVITE: "users:invite";
        readonly MANAGE: "users:manage";
    };
    readonly BILLING: {
        readonly READ: "billing:read";
        readonly MANAGE: "billing:manage";
    };
    readonly KDS: {
        readonly VIEW: "kds:view";
        readonly OPERATE: "kds:operate";
    };
    readonly DISPATCH: {
        readonly VIEW: "dispatch:view";
        readonly MANAGE: "dispatch:manage";
    };
};
type PermissionValues<T> = T extends Record<string, infer V> ? V : never;
export type Permission = PermissionValues<PermissionValues<typeof PERMISSIONS>>;
export declare const ROLE_PERMISSIONS: Record<string, Permission[]>;
export {};
//# sourceMappingURL=permissions.d.ts.map