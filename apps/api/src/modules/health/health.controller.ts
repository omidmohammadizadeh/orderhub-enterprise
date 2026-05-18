import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { QUEUES } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";

export interface HealthStatus {
  status: "ok" | "degraded" | "down";
  version: string;
  environment: string;
  uptime: number;
  timestamp: string;
  checks: Record<string, { status: "ok" | "degraded" | "down"; latencyMs?: number; detail?: string }>;
}

@ApiTags("Health")
@Controller({ path: "health", version: "1" })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectQueue(QUEUES.ORDER_PROCESSING) private readonly orderQueue: Queue,
  ) {}

  @Get()
  @Public()
  @ApiOperation({ summary: "Basic liveness check — returns 200 if the process is alive" })
  liveness(): { status: "ok"; timestamp: string } {
    return { status: "ok", timestamp: new Date().toISOString() };
  }

  @Get("ready")
  @Public()
  @ApiOperation({ summary: "Readiness probe — checks DB and Redis connectivity before serving traffic" })
  async readiness(): Promise<HealthStatus> {
    const checks: HealthStatus["checks"] = {};
    let overallStatus: HealthStatus["status"] = "ok";

    // ── Database check ───────────────────────────────────
    const dbStart = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = { status: "ok", latencyMs: Date.now() - dbStart };
    } catch (err: any) {
      checks.database = { status: "down", detail: err?.message };
      overallStatus = "down";
    }

    // ── Redis / queue check ──────────────────────────────
    const redisStart = Date.now();
    try {
      await this.orderQueue.client.ping();
      checks.redis = { status: "ok", latencyMs: Date.now() - redisStart };
    } catch (err: any) {
      checks.redis = { status: "degraded", detail: err?.message };
      if (overallStatus === "ok") overallStatus = "degraded";
    }

    return {
      status: overallStatus,
      version: process.env.npm_package_version ?? "0.0.0",
      environment: this.config.get<string>("app.nodeEnv") ?? "unknown",
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  @Get("live")
  @Public()
  @ApiOperation({ summary: "Kubernetes liveness probe endpoint" })
  kubeLiveness(): { status: "ok" } {
    return { status: "ok" };
  }
}
