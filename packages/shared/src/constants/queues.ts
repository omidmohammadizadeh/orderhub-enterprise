// Bull queue names — used by both the API (producers) and worker (consumers).
// A single source of truth prevents typos across the codebase.

export const QUEUES = {
  ORDER_PROCESSING: "order-processing",
  ORDER_SYNC: "order-sync",
  MENU_SYNC: "menu-sync",
  NOTIFICATIONS: "notifications",
  PRINTING: "printing",
  ANALYTICS: "analytics",
  WEBHOOK_DISPATCH: "webhook-dispatch",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

// Job names within each queue
export const ORDER_JOBS = {
  INGEST: "ingest",
  ACCEPT: "accept",
  NOTIFY_KDS: "notify-kds",
  TRIGGER_PRINT: "trigger-print",
  SYNC_STATUS: "sync-status",
  STATUS_CHANGE: "status-change",
} as const;

export const PRINT_JOBS = {
  RECEIPT: "receipt",
  KITCHEN_TICKET: "kitchen-ticket",
  LABEL: "label",
  DRIVER_RECEIPT: "driver-receipt",
  CANCEL_TICKET: "cancel-ticket",
  REPRINT: "reprint",
  EOD_REPORT: "eod-report",
} as const;

export const MENU_JOBS = {
  PUSH_TO_PLATFORM: "push-to-platform",
  PULL_FROM_PLATFORM: "pull-from-platform",
  VALIDATE: "validate",
} as const;

export const NOTIFICATION_JOBS = {
  EMAIL: "email",
  PUSH: "push",
  SLACK: "slack",
} as const;
