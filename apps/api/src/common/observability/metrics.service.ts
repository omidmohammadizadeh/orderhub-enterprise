import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  IMetricsRecorder,
  IErrorTracker,
  MetricName,
  MetricTags,
} from "./observability.interfaces";

// ── No-op implementations ──────────────────────────────────────────────────
// Drop-in replacements that log metrics locally when external providers are
// not configured. Swap by overriding providers in ObservabilityModule.

@Injectable()
export class MetricsService implements IMetricsRecorder {
  private readonly logger = new Logger(MetricsService.name);
  private readonly isProduction: boolean;

  constructor(private readonly config: ConfigService) {
    this.isProduction = config.get<string>("app.nodeEnv") === "production";
  }

  increment(metric: MetricName, tags?: MetricTags): void {
    if (!this.isProduction) {
      this.logger.debug(`[metric:count] ${metric} ${this.formatTags(tags)}`);
    }
    // TODO: this.datadogClient?.increment(metric, 1, this.toDatadogTags(tags));
    // TODO: prometheusCounters.get(metric)?.inc(tags);
  }

  gauge(metric: MetricName, value: number, tags?: MetricTags): void {
    if (!this.isProduction) {
      this.logger.debug(`[metric:gauge] ${metric}=${value} ${this.formatTags(tags)}`);
    }
    // TODO: this.datadogClient?.gauge(metric, value, this.toDatadogTags(tags));
  }

  timing(metric: MetricName, durationMs: number, tags?: MetricTags): void {
    if (!this.isProduction) {
      this.logger.debug(`[metric:timing] ${metric}=${durationMs}ms ${this.formatTags(tags)}`);
    }
    // TODO: this.datadogClient?.histogram(metric, durationMs, this.toDatadogTags(tags));
  }

  private formatTags(tags?: MetricTags): string {
    if (!tags) return "";
    return Object.entries(tags)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");
  }
}

@Injectable()
export class ErrorTrackerService implements IErrorTracker {
  private readonly logger = new Logger(ErrorTrackerService.name);

  captureException(err: Error, context?: Record<string, unknown>): void {
    this.logger.error(
      `[error-tracker] ${err.message}`,
      JSON.stringify({ stack: err.stack, ...context }),
    );
    // TODO: Sentry.captureException(err, { extra: context });
  }

  captureMessage(
    message: string,
    level: "info" | "warning" | "error",
    context?: Record<string, unknown>,
  ): void {
    this.logger[level === "error" ? "error" : level === "warning" ? "warn" : "log"](
      `[error-tracker] ${message}`,
      JSON.stringify(context),
    );
    // TODO: Sentry.captureMessage(message, { level, extra: context });
  }

  setUser(id: string, tenantId: string): void {
    // TODO: Sentry.setUser({ id, tenantId });
  }

  setTag(key: string, value: string): void {
    // TODO: Sentry.setTag(key, value);
  }

  async flush(): Promise<void> {
    // TODO: await Sentry.flush(2000);
  }
}
