import { apiClient } from "./client";

export interface Printer {
  id: string;
  name: string;
  type: string;
  connectionType: string;
  kind: string;
  ipAddress: string | null;
  port: number | null;
  isOnline: boolean;
  isActive: boolean;
  model: string | null;
  paperWidth: number;
  agentId: string | null;
  locationId: string;
  defaults: any;
  autoPrintRules: any;
  supportsReceipts: boolean;
  supportsKitchen: boolean;
  supportsLabels: boolean;
  supportsCut: boolean;
  supportsCashDrawer: boolean;
  // True when this printer is the location's auto-print receipt target.
  isReceiptDefault?: boolean;
}

export interface PrintJobRow {
  id: string;
  type: string;
  status: string;
  printerId: string | null;
  copies: number;
  attempts: number;
  error: string | null;
  createdAt: string;
  printedAt: string | null;
}

export interface PrintAgent {
  id: string;
  name: string;
  kind: string;
  locationId: string;
  isActive: boolean;
  versionString: string | null;
  osType: string | null;
  hostname: string | null;
  printerCount: number;
  lastSeenAt: string | null;
  deviceName: string | null;
  deviceId: string | null;
}

export interface PrinterStation {
  id: string;
  name: string;
  kind: string;
  locationId: string;
  defaultPrinterId: string | null;
  defaultPrinter: { id: string; name: string } | null;
  sortOrder: number;
  isActive: boolean;
}

export interface Widgets {
  online: number;
  offline: number;
  queueDepth: number;
  failedLast24h: number;
  lastPrintedAt: string | null;
}

export interface AlertConfig {
  id: string;
  locationId: string;
  stationId: string | null;
  trigger: string;
  enabled: boolean;
  soundUrl: string | null;
  volume: number;
  repeatCount: number;
  repeatIntervalMs: number;
  autoStopSeconds: number | null;
  requireAcknowledgement: boolean;
}

export const printersClient = {
  list: (locationId?: string) =>
    apiClient
      .get<Printer[]>("/v1/printers", {
        params: locationId ? { locationId } : undefined,
      })
      .then((r) => r.data),
  // Recent print jobs for a location (newest first). Drives the
  // "Recent prints" list on the Printers page.
  listJobs: (locationId?: string, limit = 20) =>
    apiClient
      .get<PrintJobRow[]>("/v1/print-jobs", {
        params: { ...(locationId ? { locationId } : {}), limit },
      })
      .then((r) => r.data),
  // Polling fallback for bridge auto-print: QUEUED jobs (with payload)
  // the tablet should print over Bluetooth right now.
  pendingBridgeJobs: (locationId?: string) =>
    apiClient
      .get<
        Array<{
          id: string;
          printerId: string | null;
          type: string;
          copies: number;
          trigger: string | null;
          payload: any;
        }>
      >("/v1/print-jobs/pending-bridge", {
        params: locationId ? { locationId } : undefined,
      })
      .then((r) => r.data),
  // Cancel every pending/stuck print job (optionally one location).
  clearQueue: (locationId?: string) =>
    apiClient
      .post<{ cleared: number }>("/v1/print-jobs/clear-queue", null, {
        params: locationId ? { locationId } : undefined,
      })
      .then((r) => r.data),
  // After the tablet prints an order's receipt itself, clear that
  // order's server-side job(s) from the queue + bump "last print".
  markOrderPrinted: (orderId: string) =>
    apiClient
      .post(`/v1/print-jobs/order/${orderId}/printed`, {})
      .then((r) => r.data)
      .catch(() => null),
  // Log a print outcome (failure or test) into the activity feed. Success
  // order prints are already logged by markOrderPrinted, so this is mainly
  // for failures + test prints. Best-effort — never throws.
  reportPrint: (report: {
    ok: boolean;
    orderId?: string;
    printerName?: string;
    message?: string;
    kind?: "order" | "auto" | "test" | "reprint";
  }) =>
    apiClient
      .post(`/v1/print-jobs/report`, report)
      .then((r) => r.data)
      .catch(() => null),
  // Turn automatic order printing on/off for this printer's location.
  setReceiptDefault: (id: string, active: boolean) =>
    apiClient
      .post(`/v1/printers/${id}/receipt-default`, { active })
      .then((r) => r.data),
  create: (body: Partial<Printer> & { locationId: string }) =>
    apiClient.post<Printer>("/v1/printers", body).then((r) => r.data),
  update: (id: string, body: Partial<Printer>) =>
    apiClient.patch<Printer>(`/v1/printers/${id}`, body).then((r) => r.data),
  remove: (id: string) =>
    apiClient.delete(`/v1/printers/${id}`).then((r) => r.data),
  widgets: (locationId?: string) =>
    apiClient
      .get<Widgets>("/v1/print-jobs/widgets", {
        params: locationId ? { locationId } : undefined,
      })
      .then((r) => r.data),
  reprint: (orderId: string, types: string[]) =>
    apiClient
      .post("/v1/print-jobs/reprint", { orderId, types })
      .then((r) => r.data),
  testPrint: (printerId: string) =>
    apiClient
      .post("/v1/print-jobs/test-print", { printerId })
      .then((r) => r.data),
  // Mark a job PRINTED after the native Bluetooth bridge rendered it on
  // the tablet. Clears it out of the Printers-page queue (the bridge
  // doesn't go through the agent claim/complete cycle).
  markBridgePrinted: (jobId: string) =>
    apiClient
      .post(`/v1/print-jobs/${jobId}/bridge-printed`, {})
      .then((r) => r.data),
};

export const printAgentsClient = {
  list: (locationId?: string) =>
    apiClient
      .get<PrintAgent[]>("/v1/print-agents", {
        params: locationId ? { locationId } : undefined,
      })
      .then((r) => r.data),
  createPairCode: (locationId: string) =>
    apiClient
      .post<{ code: string; expiresAt: string; qr: string }>(
        "/v1/print-agents/pair-codes",
        { locationId },
      )
      .then((r) => r.data),
  rotateToken: (id: string) =>
    apiClient
      .post<{ apiToken: string }>(`/v1/print-agents/${id}/rotate-token`)
      .then((r) => r.data),
  revoke: (id: string) =>
    apiClient.delete(`/v1/print-agents/${id}`).then((r) => r.data),
};

export const printerStationsClient = {
  list: (locationId?: string) =>
    apiClient
      .get<PrinterStation[]>("/v1/printer-stations", {
        params: locationId ? { locationId } : undefined,
      })
      .then((r) => r.data),
  create: (body: {
    locationId: string;
    name: string;
    kind?: string;
    defaultPrinterId?: string | null;
    sortOrder?: number;
  }) =>
    apiClient
      .post<PrinterStation>("/v1/printer-stations", body)
      .then((r) => r.data),
  update: (id: string, body: Partial<PrinterStation>) =>
    apiClient
      .patch<PrinterStation>(`/v1/printer-stations/${id}`, body)
      .then((r) => r.data),
  remove: (id: string) =>
    apiClient.delete(`/v1/printer-stations/${id}`).then((r) => r.data),
};

export const alertsClient = {
  list: (locationId?: string) =>
    apiClient
      .get<AlertConfig[]>("/v1/alerts", {
        params: locationId ? { locationId } : undefined,
      })
      .then((r) => r.data),
  upsert: (body: Partial<AlertConfig> & {
    locationId: string;
    trigger: string;
  }) =>
    apiClient.put<AlertConfig>("/v1/alerts", body).then((r) => r.data),
  remove: (id: string) =>
    apiClient.delete(`/v1/alerts/${id}`).then((r) => r.data),
  ack: (body: { locationId: string; trigger: string; referenceKey: string }) =>
    apiClient.post("/v1/alerts/ack", body).then((r) => r.data),
};

export const ALERT_TRIGGERS = [
  { value: "NEW_ORDER", label: "New order" },
  { value: "ORDER_CANCELLED", label: "Order cancelled" },
  { value: "RIDER_ARRIVED", label: "Rider arrived" },
  { value: "SCHEDULED_ORDER_READY", label: "Scheduled order ready" },
  { value: "PRINTER_OFFLINE", label: "Printer offline" },
  { value: "FAILED_PRINT", label: "Failed print" },
] as const;

export const PRINT_TRIGGERS = [
  "ORDER_RECEIVED",
  "ORDER_ACCEPTED",
  "ORDER_PREPARING",
  "ORDER_READY",
  "MANUAL_ONLY",
] as const;
