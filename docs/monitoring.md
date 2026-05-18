# Monitoring Strategy

## Observability Architecture

OrderHub uses a provider-agnostic observability layer (`ObservabilityModule`). The interfaces are defined in `apps/api/src/common/observability/observability.interfaces.ts`. Concrete implementations can be plugged in by swapping providers in `ObservabilityModule`.

Current state: no-op implementations that log metrics to the Winston logger in development. Production integrations are wired via TODO comments in `MetricsService` and `ErrorTrackerService`.

### Planned Provider Stack

| Concern | Provider | Interface |
|---|---|---|
| Error tracking | Sentry | `IErrorTracker` |
| APM / distributed tracing | Datadog APM or OpenTelemetry | `ITracer` |
| Metrics | Datadog StatsD or Prometheus | `IMetricsRecorder` |
| Logs | Datadog Logs or Grafana Loki | Winston JSON transport |
| Dashboards | Grafana | Prometheus/Datadog source |

## Key Metrics

### Business Metrics

| Metric | Tags | Alert threshold |
|---|---|---|
| `order.created` | `platform`, `locationId` | — |
| `order.status_changed` | `from`, `to`, `locationId` | — |
| `order.cancelled` | `locationId`, `platform` | > 10% of orders in 15 min |

### Reliability Metrics

| Metric | Tags | Alert threshold |
|---|---|---|
| `webhook.rejected` | `platform`, `locationId` | > 5 in 5 min |
| `queue.job.failed` | `queue`, `jobName` | > 3 consecutive failures |
| `queue.dlq.added` | `queue` | Any occurrence |
| `integration.sync.failure` | `platform`, `locationId` | > 3 in 5 min |
| `print.job.failed` | `locationId`, `printerId` | > 5 in 10 min |

### Infrastructure Metrics

| Metric | Alert threshold |
|---|---|
| API response p99 > 2s | Warning |
| API response p99 > 5s | Critical |
| DB connection pool exhausted | Critical |
| Redis memory > 80% | Warning |
| Queue depth > 1000 waiting | Warning |

## Structured Logging

All API and Worker logs are structured JSON in production (set via `winstonConfig` in `apps/api/src/config/logger.config.ts`). Every log line includes:

- `timestamp` — ISO 8601
- `level` — error/warn/info/debug
- `context` — NestJS logger context (e.g. `OrdersService`, `HTTP`)
- `message`
- `requestId` — from `x-request-id` header (via `LoggingInterceptor`)
- `stack` — on errors

Example:
```json
{
  "timestamp": "2024-01-15T12:34:56.789Z",
  "level": "info",
  "context": "HTTP",
  "message": "POST /api/v1/orders 201 145ms [req-abc123]",
  "requestId": "req-abc123"
}
```

## Request Tracing

Every HTTP request gets an `x-request-id` UUID (or the client-provided one if supplied). This ID is:

- Attached to the request as a header
- Echoed in the response `x-request-id` header
- Included in every log line for that request lifecycle
- Propagated to BullMQ job data (`requestId` field)
- Included in WebhookEvent records

To trace a full webhook → order → print → sync chain, search logs for the same `requestId`.

## Health Checks

| Check | Endpoint | Interval |
|---|---|---|
| Liveness | `GET /api/v1/health` | 10s |
| Readiness | `GET /api/v1/health/ready` | 30s |
| Docker healthcheck | `wget -qO- http://localhost:4000/api/v1/health` | 30s |

The readiness check verifies:
1. Postgres connectivity (`SELECT 1`)
2. Redis connectivity (queue client `PING`)

## Queue Monitoring

The Admin API (`GET /api/v1/admin/queues`) exposes real-time queue stats. For a visual dashboard, Bull Board is available at `http://localhost:3001` in development.

In production, configure Bull Board with authentication behind your internal network.

### DLQ Visibility

Failed jobs that have exhausted retries accumulate in Bull's failed set. Use:

```bash
GET /api/v1/admin/queues/{queue}/failed
```

To retry all failed jobs in a queue:

```bash
POST /api/v1/admin/queues/{queue}/failed/retry-all
```

## Alerting Strategy

Priority 1 — immediate page (PD or OpsGenie):
- Health endpoint returning non-200
- Database unreachable
- Redis unreachable
- Any DLQ additions

Priority 2 — Slack notification:
- Webhook signature rejection rate spike
- Integration sync failure rate spike
- Print job failure rate spike
- API error rate > 1%

Priority 3 — email digest:
- Queue depth trends
- Daily order volume anomalies
- Failed login rate > normal

## Integration with Providers

### Sentry

1. Set `SENTRY_DSN` in production env
2. In `ErrorTrackerService`, replace `// TODO` with `Sentry.captureException(err, { extra: context })`
3. Add `@sentry/node` to `apps/api/package.json`
4. Initialize in `main.ts` before `NestFactory.create`

### Datadog

1. Set `DATADOG_API_KEY` in production env
2. Install `hot-shots` for StatsD client
3. Replace `// TODO` comments in `MetricsService` with `statsd.increment(metric, tags)`
4. Use Datadog agent sidecar in Docker Compose / K8s

### OpenTelemetry

1. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME`
2. Add `@opentelemetry/sdk-node` and `@opentelemetry/auto-instrumentations-node`
3. Initialize in a `tracing.ts` file imported at the top of `main.ts`
4. Replace `ITracer` no-op with OTEL SDK spans
