export declare const QUEUES: {
    readonly ORDER_PROCESSING: "order-processing";
    readonly ORDER_SYNC: "order-sync";
    readonly MENU_SYNC: "menu-sync";
    readonly NOTIFICATIONS: "notifications";
    readonly PRINTING: "printing";
    readonly ANALYTICS: "analytics";
    readonly WEBHOOK_DISPATCH: "webhook-dispatch";
};
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export declare const ORDER_JOBS: {
    readonly INGEST: "ingest";
    readonly ACCEPT: "accept";
    readonly NOTIFY_KDS: "notify-kds";
    readonly TRIGGER_PRINT: "trigger-print";
    readonly SYNC_STATUS: "sync-status";
};
export declare const MENU_JOBS: {
    readonly PUSH_TO_PLATFORM: "push-to-platform";
    readonly PULL_FROM_PLATFORM: "pull-from-platform";
    readonly VALIDATE: "validate";
};
export declare const NOTIFICATION_JOBS: {
    readonly EMAIL: "email";
    readonly PUSH: "push";
    readonly SLACK: "slack";
};
//# sourceMappingURL=queues.d.ts.map