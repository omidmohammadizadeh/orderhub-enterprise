"use strict";
// Dot-notation event identifiers written to the audit_logs table.
// Using constants prevents silent typos across producer/consumer code.
Object.defineProperty(exports, "__esModule", { value: true });
exports.AUDIT_EVENTS = void 0;
exports.AUDIT_EVENTS = {
    AUTH: {
        LOGIN_SUCCESS: "auth.login.success",
        LOGIN_FAILURE: "auth.login.failure",
        LOGOUT: "auth.logout",
        TOKEN_REFRESH: "auth.token.refresh",
        // A revoked refresh token was presented again — likely token theft.
        TOKEN_THEFT_DETECTED: "auth.token.theft_detected",
        OAUTH_LINKED: "auth.oauth.linked",
        OAUTH_UNLINKED: "auth.oauth.unlinked",
        PASSWORD_CHANGED: "auth.password.changed",
        PASSWORD_RESET_REQUESTED: "auth.password.reset_requested",
        ACCOUNT_LOCKED: "auth.account.locked",
        ACCOUNT_UNLOCKED: "auth.account.unlocked",
    },
    USER: {
        CREATED: "user.created",
        UPDATED: "user.updated",
        DELETED: "user.deleted",
        ROLE_CHANGED: "user.role.changed",
        PERMISSIONS_CHANGED: "user.permissions.changed",
    },
    TENANT: {
        CREATED: "tenant.created",
        PLAN_CHANGED: "tenant.plan.changed",
        SUSPENDED: "tenant.suspended",
    },
    INTEGRATION: {
        CONNECTED: "integration.connected",
        DISCONNECTED: "integration.disconnected",
        CREDENTIALS_ROTATED: "integration.credentials.rotated",
    },
};
//# sourceMappingURL=audit-events.js.map