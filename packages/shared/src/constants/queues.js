"use strict";
// Bull queue names — used by both the API (producers) and worker (consumers).
// A single source of truth prevents typos across the codebase.
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOTIFICATION_JOBS = exports.MENU_JOBS = exports.ORDER_JOBS = exports.QUEUES = void 0;
exports.QUEUES = {
    ORDER_PROCESSING: "order-processing",
    ORDER_SYNC: "order-sync",
    MENU_SYNC: "menu-sync",
    NOTIFICATIONS: "notifications",
    PRINTING: "printing",
    ANALYTICS: "analytics",
    WEBHOOK_DISPATCH: "webhook-dispatch",
};
// Job names within each queue
exports.ORDER_JOBS = {
    INGEST: "ingest",
    ACCEPT: "accept",
    NOTIFY_KDS: "notify-kds",
    TRIGGER_PRINT: "trigger-print",
    SYNC_STATUS: "sync-status",
};
exports.MENU_JOBS = {
    PUSH_TO_PLATFORM: "push-to-platform",
    PULL_FROM_PLATFORM: "pull-from-platform",
    VALIDATE: "validate",
};
exports.NOTIFICATION_JOBS = {
    EMAIL: "email",
    PUSH: "push",
    SLACK: "slack",
};
//# sourceMappingURL=queues.js.map