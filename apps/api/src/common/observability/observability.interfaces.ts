// ── Provider-agnostic observability interfaces ─────────────────────────────
// Concrete implementations (Sentry, Datadog, OpenTelemetry) are injected via
// the ObservabilityModule. Application code only depends on these interfaces.

export interface IErrorTracker {
  captureException(err: Error, context?: Record<string, unknown>): void;
  captureMessage(message: string, level: "info" | "warning" | "error", context?: Record<string, unknown>): void;
  setUser(id: string, tenantId: string): void;
  setTag(key: string, value: string): void;
  flush(): Promise<void>;
}

export interface IMetricsRecorder {
  // Counters
  increment(metric: MetricName, tags?: MetricTags): void;
  // Gauges (current value)
  gauge(metric: MetricName, value: number, tags?: MetricTags): void;
  // Histograms / timing
  timing(metric: MetricName, durationMs: number, tags?: MetricTags): void;
}

export interface ITracer {
  startSpan(name: string, parent?: unknown): ISpan;
  getCurrentSpan(): ISpan | undefined;
}

export interface ISpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: "ok" | "error", message?: string): void;
  end(): void;
}

// ── Metric names ────────────────────────────────────────────────────────────
export type MetricName =
  // Webhooks
  | "webhook.received"
  | "webhook.verified"
  | "webhook.rejected"
  | "webhook.duplicate"
  | "webhook.processed"
  | "webhook.error"
  // Orders
  | "order.created"
  | "order.status_changed"
  | "order.cancelled"
  | "order.completed"
  // Queues
  | "queue.job.enqueued"
  | "queue.job.completed"
  | "queue.job.failed"
  | "queue.job.retried"
  | "queue.dlq.added"
  | "queue.job.duration"
  // Print
  | "print.job.queued"
  | "print.job.printed"
  | "print.job.failed"
  | "print.job.retried"
  // Socket
  | "socket.connection.opened"
  | "socket.connection.closed"
  | "socket.event.emitted"
  | "socket.connection.count"
  // Integration sync
  | "integration.sync.success"
  | "integration.sync.failure"
  | "integration.sync.retried"
  // HTTP
  | "http.request"
  | "http.request.duration"
  | "http.error";

export type MetricTags = Record<string, string | number | boolean>;
