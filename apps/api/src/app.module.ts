import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { BullModule } from "@nestjs/bull";
import { WinstonModule } from "nest-winston";
import { CacheModule } from "@nestjs/cache-manager";
import { ScheduleModule } from "@nestjs/schedule";
// cache-manager-redis-store removed — uses in-memory store for staging compatibility.
// cache-manager v5 requires an async store factory for Redis; the legacy sync API
// causes a silent hang at startup when connecting to Upstash rediss:// TLS URLs.

import { RequestIdMiddleware } from "./common/middleware/request-id.middleware";
import { MaintenanceMiddleware } from "./common/middleware/maintenance.middleware";
import { LoggingInterceptor } from "./common/interceptors/logging.interceptor";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { RolesGuard } from "./common/guards/roles.guard";
import { BillingGuard } from "./common/guards/billing.guard";

import { appConfig } from "./config/app.config";
import { winstonConfig } from "./config/logger.config";

// ── Infrastructure ─────────────────────────────────────────
import { DatabaseModule } from "./infrastructure/database/database.module";
import { SocketModule } from "./infrastructure/socket/socket.module";
import { ObservabilityModule } from "./common/observability/observability.module";

// ── Domain Modules ─────────────────────────────────────────
import { HealthModule } from "./modules/health/health.module";
import { AuthModule } from "./modules/auth/auth.module";
import { TenantsModule } from "./modules/tenants/tenants.module";
import { BrandsModule } from "./modules/brands/brands.module";
import { LocationsModule } from "./modules/locations/locations.module";
import { UsersModule } from "./modules/users/users.module";
import { MenusModule } from "./modules/menus/menus.module";
import { CatalogModule } from "./modules/catalog/catalog.module";
import { OrdersModule } from "./modules/orders/orders.module";
import { IntegrationsModule } from "./modules/integrations/integrations.module";
import { WebhooksModule } from "./modules/webhooks/webhooks.module";
import { DispatchModule } from "./modules/dispatch/dispatch.module";
import { AnalyticsModule } from "./modules/analytics/analytics.module";
import { KdsModule } from "./modules/kds/kds.module";
import { PrintersModule } from "./modules/printers/printers.module";
import { AdminModule } from "./modules/admin/admin.module";
import { OrderingModule } from "./modules/ordering/ordering.module";
import { StoreOpsModule } from "./modules/store-ops/store-ops.module";
import { CustomersModule } from "./modules/customers/customers.module";
import { DriversModule } from "./modules/drivers/drivers.module";
import { PaymentsModule } from "./modules/payments/payments.module";
import { BillingModule } from "./modules/billing/billing.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { SecurityModule } from "./modules/security/security.module";
import { BrandingModule } from "./modules/branding/branding.module";
import { ProviderRegistryModule } from "./modules/provider-registry/provider-registry.module";
import { MobileModule } from "./modules/mobile/mobile.module";
import { InventoryModule } from "./modules/inventory/inventory.module";
import { SandboxModule } from "./modules/sandbox/sandbox.module";
import { OutboxModule } from "./modules/outbox/outbox.module";
import { OnboardingModule } from "./modules/onboarding/onboarding.module";
import { DeliveryZonesModule } from "./modules/delivery-zones/delivery-zones.module";
import { PromoCodesModule } from "./modules/promo-codes/promo-codes.module";
import { AddressLookupModule } from "./modules/address-lookup/address-lookup.module";
import { QUEUES } from "@orderhub/shared";

@Module({
  imports: [
    // ── Configuration ──────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: [".env.local", `.env.${process.env.NODE_ENV ?? "development"}`, ".env"],
      validate: (config) => {
        // Dynamic require avoids circular-dependency issues at module evaluation time
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { validateEnv } = require("./config/env.validation");
        return validateEnv(config);
      },
    }),

    // ── Logging ─────────────────────────────────────────
    WinstonModule.forRoot(winstonConfig),

    // ── Observability (global — no need to import in each module) ─────────
    ObservabilityModule,

    // ── Rate Limiting ────────────────────────────────────
    // Throttler names are referenced by @Throttle() decorators on specific routes.
    // The default (no decorator) applies "short" + "medium" simultaneously.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        { name: "short",   ttl: 1000,  limit: 10 },   // 10 req/s — burst protection
        { name: "medium",  ttl: 60000, limit: 200 },   // 200 req/min — sustained
        {
          name: "webhook",
          ttl: config.get<number>("app.throttle.webhookTtl") ?? 60000,
          limit: config.get<number>("app.throttle.webhookLimit") ?? 300,
        },
        {
          name: "login",
          ttl: config.get<number>("app.throttle.loginTtl") ?? 60000,
          limit: config.get<number>("app.throttle.loginLimit") ?? 10,
        },
      ],
    }),

    // ── In-Memory Cache ───────────────────────────────────
    // Using built-in memory store for staging. The legacy cache-manager-redis-store
    // v3 API hangs at startup when connecting to Upstash (rediss:// TLS).
    // Upgrade path: replace with cache-manager-ioredis-yet when needed.
    CacheModule.register({
      isGlobal: true,
      ttl: 300_000, // 5 minutes in ms (cache-manager v5 uses milliseconds)
      max: 1000,    // max entries in memory
    }),

    // ── Bull Queues ──────────────────────────────────────
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        url: config.get<string>("QUEUE_REDIS_URL"),
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

    // ── Scheduled Tasks ──────────────────────────────────
    ScheduleModule.forRoot(),

    // ── Infrastructure ───────────────────────────────────
    DatabaseModule,
    SocketModule,

    // ── Operational ──────────────────────────────────────
    HealthModule,
    AdminModule,

    // ── Domain ───────────────────────────────────────────
    AuthModule,
    UsersModule,
    TenantsModule,
    BrandsModule,
    LocationsModule,
    MenusModule,
    CatalogModule,
    OrdersModule,
    IntegrationsModule,
    WebhooksModule,
    DispatchModule,
    AnalyticsModule,
    KdsModule,
    PrintersModule,
    OrderingModule,
    StoreOpsModule,
    CustomersModule,
    DriversModule,
    PaymentsModule,
    BillingModule,
    NotificationsModule,
    SecurityModule,
    BrandingModule,
    ProviderRegistryModule,
    MobileModule,
    InventoryModule,
    SandboxModule,
    OutboxModule,
    OnboardingModule,
    DeliveryZonesModule,
    PromoCodesModule,
    AddressLookupModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: BillingGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestIdMiddleware, MaintenanceMiddleware)
      .forRoutes("*");
  }
}
