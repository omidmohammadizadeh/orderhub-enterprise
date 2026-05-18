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
import { CredentialEncryptionService } from "./infrastructure/credential-encryption.service";

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
        url: config.get<string>("QUEUE_REDIS_URL") ?? "redis://localhost:6379",
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
      { name: QUEUES.ORDER_SYNC },
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
