import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { BullModule } from "@nestjs/bull";
import { WinstonModule } from "nest-winston";
import * as winston from "winston";
import { QUEUES } from "@orderhub/shared";
import { OrderProcessingProcessor } from "./processors/order-processing.processor";
import { OrderSyncProcessor } from "./processors/order-sync.processor";
import { PrintingProcessor } from "./processors/printing.processor";
import { MenuSyncProcessor } from "./processors/menu-sync.processor";
import { PrismaService } from "./infrastructure/prisma.service";
import { EventPublisherService } from "./infrastructure/event-publisher.service";
import {
  PlatformSyncFactory,
  UberEatsSyncClient,
  DeliverooSyncClient,
  JustEatSyncClient,
  HubRiseSyncClient,
} from "./sync/platform-sync.factory";
import { TokenRefreshService } from "./sync/token-refresh.service";
import { rateLimitAwareBackoff } from "./sync/backoff-strategies";
import { CredentialEncryptionService } from "./infrastructure/credential-encryption.service";

// See app.module.ts — pass ioredis options (not bare url) so we can set
// maxRetriesPerRequest:null + enableReadyCheck:false for Bull + Upstash.
function bullRedisOptions(raw: string | undefined): Record<string, unknown> {
  const base = { maxRetriesPerRequest: null, enableReadyCheck: false };
  // Strip accidental surrounding quotes/whitespace; never crash on a bad URL.
  const cleaned = (raw ?? "").trim().replace(/^['"]|['"]$/g, "");
  try {
    const url = new URL(cleaned || "redis://localhost:6379");
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : 6379,
      username: decodeURIComponent(url.username || "default"),
      password: decodeURIComponent(url.password || ""),
      ...(url.protocol === "rediss:" ? { tls: {} } : {}),
      ...base,
    };
  } catch {
    return { host: "127.0.0.1", port: 6379, ...base };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env.local", ".env"],
    }),

    WinstonModule.forRoot({
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message, context }) =>
              `${timestamp} [${context ?? "Worker"}] ${level}: ${message}`,
            ),
          ),
        }),
      ],
    }),

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        redis: bullRedisOptions(config.get<string>("QUEUE_REDIS_URL")),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      }),
    }),

    BullModule.registerQueue(
      { name: QUEUES.ORDER_PROCESSING },
      {
        name: QUEUES.ORDER_SYNC,
        // Register the rate-limit-aware backoff strategy so provider
        // Retry-After delays are honoured instead of using exponential alone.
        settings: {
          backoffStrategies: {
            "rate-limit-aware": rateLimitAwareBackoff,
          },
        },
      },
      { name: QUEUES.MENU_SYNC },
      { name: QUEUES.NOTIFICATIONS },
      { name: QUEUES.PRINTING },
      { name: QUEUES.ANALYTICS },
      { name: QUEUES.WEBHOOK_DISPATCH },
    ),
  ],
  providers: [
    PrismaService,
    EventPublisherService,
    CredentialEncryptionService,
    // Sync clients
    UberEatsSyncClient,
    DeliverooSyncClient,
    JustEatSyncClient,
    HubRiseSyncClient,
    PlatformSyncFactory,
    TokenRefreshService,
    // Processors
    OrderProcessingProcessor,
    OrderSyncProcessor,
    PrintingProcessor,
    MenuSyncProcessor,
  ],
})
export class WorkerModule {}
