export declare const AUDIT_EVENTS: {
    readonly AUTH: {
        readonly LOGIN_SUCCESS: "auth.login.success";
        readonly LOGIN_FAILURE: "auth.login.failure";
        readonly LOGOUT: "auth.logout";
        readonly TOKEN_REFRESH: "auth.token.refresh";
        readonly TOKEN_THEFT_DETECTED: "auth.token.theft_detected";
        readonly OAUTH_LINKED: "auth.oauth.linked";
        readonly OAUTH_UNLINKED: "auth.oauth.unlinked";
        readonly PASSWORD_CHANGED: "auth.password.changed";
        readonly PASSWORD_RESET_REQUESTED: "auth.password.reset_requested";
        readonly ACCOUNT_LOCKED: "auth.account.locked";
        readonly ACCOUNT_UNLOCKED: "auth.account.unlocked";
    };
    readonly USER: {
        readonly CREATED: "user.created";
        readonly UPDATED: "user.updated";
        readonly DELETED: "user.deleted";
        readonly ROLE_CHANGED: "user.role.changed";
        readonly PERMISSIONS_CHANGED: "user.permissions.changed";
    };
    readonly TENANT: {
        readonly CREATED: "tenant.created";
        readonly PLAN_CHANGED: "tenant.plan.changed";
        readonly SUSPENDED: "tenant.suspended";
    };
    readonly INTEGRATION: {
        readonly CONNECTED: "integration.connected";
        readonly DISCONNECTED: "integration.disconnected";
        readonly CREDENTIALS_ROTATED: "integration.credentials.rotated";
    };
};
export type AuditEventKey = (typeof AUDIT_EVENTS.AUTH)[keyof typeof AUDIT_EVENTS.AUTH] | (typeof AUDIT_EVENTS.USER)[keyof typeof AUDIT_EVENTS.USER] | (typeof AUDIT_EVENTS.TENANT)[keyof typeof AUDIT_EVENTS.TENANT] | (typeof AUDIT_EVENTS.INTEGRATION)[keyof typeof AUDIT_EVENTS.INTEGRATION];
//# sourceMappingURL=audit-events.d.ts.map