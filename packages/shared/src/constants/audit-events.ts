// Dot-notation event identifiers written to the audit_logs table.
// Using constants prevents silent typos across producer/consumer code.

export const AUDIT_EVENTS = {
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
} as const;

export type AuditEventKey =
  | (typeof AUDIT_EVENTS.AUTH)[keyof typeof AUDIT_EVENTS.AUTH]
  | (typeof AUDIT_EVENTS.USER)[keyof typeof AUDIT_EVENTS.USER]
  | (typeof AUDIT_EVENTS.TENANT)[keyof typeof AUDIT_EVENTS.TENANT]
  | (typeof AUDIT_EVENTS.INTEGRATION)[keyof typeof AUDIT_EVENTS.INTEGRATION];
