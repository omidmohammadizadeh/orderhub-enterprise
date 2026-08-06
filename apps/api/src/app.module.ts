import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import { UserThrottlerGuard } from "./common/guards/user-throttler.guard";
import { BullModule } from "@nestjs/bull";
import { WinstonModule } from "nest-winston";
import { CacheModule } from "@nestjs/cache-manager";
import { ScheduleModule } from "@nestjs/schedule";
import { EventEmitterModule } from "@nestjs/event-emitter";
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
import { EmailModule } from "./infrastructure/email/email.module";
import { ObservabilityModule } from "./common/observability/observability.module";

// ── Domain Modules ─────────────────────────────────────────
import { HealthModule } from "./modules/health/health.module";
import { AuthModule } from "./modules/auth/auth.module";
import { CustomerAuthModule } from "./modules/customer-auth/customer-auth.module";
import { TenantsModule } from "./modules/tenants/tenants.module";
import { BrandsModule } from "./modules/brands/brands.module";
import { LocationsModule } from "./modules/locations/locations.module";
import { TeamModule } from "./modules/team/team.module";
import { LeadsModule } from "./modules/leads/leads.module";
import { AgentModule } from "./modules/agent/agent.module";
import { AlertsModule } from "./modules/alerts/alerts.module";
import { UsersModule } from "./modules/users/users.module";
import { MenusModule } from "./modules/menus/menus.module";
import { SignageModule } from "./modules/signage/signage.module";
import { TablesModule } from "./modules/tables/tables.module";
import { ReservationsModule } from "./modules/reservations/reservations.module";
import { CatalogModule } from "./modules/catalog/catalog.module";
import { OrdersModule } from "./modules/orders/orders.module";
import { IntegrationsModule } from "./modules/integrations/integrations.module";
import { HubRiseModule } from "./modules/integrations/hubrise/hubrise.module";
import { StuartModule } from "./modules/integrations/stuart/stuart.module";
import { UberDirectModule } from "./modules/integrations/uber-direct/uber-direct.module";
import { DeliverooModule } from "./modules/integrations/deliveroo/deliveroo.module";
import { UberEatsModule } from "./modules/integrations/ubereats/ubereats.module";
import { WebhooksModule } from "./modules/webhooks/webhooks.module";
import { DispatchModule } from "./modules/dispatch/dispatch.module";
import { DriverAppModule } from "./modules/driver-app/driver-app.module";
import { ExpoPushModule } from "./modules/driver-app/expo-push.module";
import { SmsModule } from "./modules/sms/sms.module";
import { WalletModule } from "./modules/wallet/wallet.module";
import { MarketingSmsModule } from "./modules/marketing-sms/marketing-sms.module";
import { ChatModule } from "./modules/chat/chat.module";
import { WhatsAppModule } from "./modules/whatsapp/whatsapp.module";
import { UploadsModule } from "./modules/uploads/uploads.module";
import { AnalyticsModule } from "./modules/analytics/analytics.module";
import { KdsModule } from "./modules/kds/kds.module";
import { LogsModule } from "./modules/logs/logs.module";
import { PrintersModule } from "./modules/printers/printers.module";
import { AdminModule } from "./modules/admin/admin.module";
import { OrderingModule } from "./modules/ordering/ordering.module";
import { StoreStatusModule } from "./modules/store-status/store-status.module";
import { CustomersModule } from "./modules/customers/customers.module";
import { DriversModule } from "./modules/drivers/drivers.module";
import { PaymentsModule } from "./modules/payments/payments.module";
import { BillingModule } from "./modules/billing/billing.module";
import { VideoStudioModule } from "./modules/video-studio/video-studio.module";
import { GroupOrdersModule } from "./modules/group-orders/group-orders.module";
import { CustomerPushModule } from "./modules/customer-push/customer-push.module";
import { VoiceModule } from "./modules/voice/voice.module";
import { ReviewsModule } from "./modules/reviews/reviews.module";
import { SubscriptionsModule } from "./modules/subscriptions/subscriptions.module";
import { ContractsModule } from "./modules/contracts/contracts.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { SecurityModule } from "./modules/security/security.module";
import { BrandingModule } from "./modules/branding/branding.module";
import { ProviderRegistryModule } from "./modules/provider-registry/provider-registry.module";
import { MobileModule } from "./modules/mobile/mobile.module";
import { InventoryModule } from "./modules/inventory/inventory.module";
import { MarketingModule } from "./modules/marketing/marketing.module";
import { PauseModule } from "./modules/pauses/pause.module";
import { SandboxModule } from "./modules/sandbox/sandbox.module";
import { OutboxModule } from "./modules/outbox/outbox.module";
import { OnboardingModule } from "./modules/onboarding/onboarding.module";
import { DeliveryZonesModule } from "./modules/delivery-zones/delivery-zones.module";
import { PromoCodesModule } from "./modules/promo-codes/promo-codes.module";
import { AddressLookupModule } from "./modules/address-lookup/address-lookup.module";
import { DirectOrderingModule } from "./modules/direct-ordering/direct-ordering.module";
import { SecretsModule } from "./modules/secrets/secrets.module";
import { BrandConnectionsModule } from "./modules/brand-connections/brand-connections.module";
import { QUEUES } from "@orderhub/shared";

// Bull/ioredis connection options derived from a redis(s):// URL. We pass an
// options object (not the bare `url`) so we can set maxRetriesPerRequest:null
// + enableReadyCheck:false — required for Bull and for managed Redis like
// Upstash, which drops idle connections. Without this, a command issued
// during a reconnect window dies with "Reached the max retries per request
// limit (which is 20)" and the queue add/outbox dispatch fails.
function bullRedisOptions(raw: string | undefined): Record<string, unknown> {
  const base = { maxRetriesPerRequest: null, enableReadyCheck: false };
  // Strip accidental surrounding quotes/whitespace (a common env-var paste
  // mistake — Upstash shows the URL as REDIS_URL="rediss://…", and copying
  // the quotes makes new URL() throw and crash boot).
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
    // Never crash the app on a malformed URL — boot and let the queue
    // connection retry in the background (the direct order flow doesn't
    // need Redis). Falls back to localhost.
    return { host: "127.0.0.1", port: 6379, ...base };
  }
}

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
    // CRITICAL @nestjs/throttler v6 semantics, learned the hard way: EVERY
    // throttler registered here applies to EVERY route unless that route
    // skips it by name. When "login" (10/min) and "webhook" (300/min) were
    // registered globally, every dashboard endpoint silently carried a
    // 10-requests-per-minute-per-user cap — several tablets signed into the
    // same account watching the orders board tripped it constantly. That
    // hidden bucket was the root cause of the recurring platform-wide 429s.
    //
    // So: ONLY the two generous general buckets are global. Abuse-sensitive
    // routes (login, password reset, public webhooks) declare their own
    // strict limits per-route via @Throttle overrides of these two names —
    // strictness stays exactly where it belongs and nowhere else.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          name: "short",
          ttl: config.get<number>("app.throttle.shortTtl") ?? 1000,
          limit: config.get<number>("app.throttle.shortLimit") ?? 120,
        }, // 120 req/s — burst protection (a dashboard load fans out ~15 calls
           // × several locations at once)
        {
          name: "medium",
          ttl: config.get<number>("app.throttle.mediumTtl") ?? 60000,
          limit: config.get<number>("app.throttle.mediumLimit") ?? 4000,
        }, // 4000 req/min — sustained polling; keyed per-user (UserThrottlerGuard)
           // so an admin watching many locations across tabs doesn't 429 itself.
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
      { name: QUEUES.ORDER_SYNC },
      { name: QUEUES.MENU_SYNC },
      { name: QUEUES.NOTIFICATIONS },
      { name: QUEUES.PRINTING },
      { name: QUEUES.ANALYTICS },
      { name: QUEUES.WEBHOOK_DISPATCH },
    ),

    // ── Scheduled Tasks ──────────────────────────────────
    ScheduleModule.forRoot(),

    // ── In-process events (order status → WhatsApp notify, etc.) ─────────
    EventEmitterModule.forRoot(),

    // ── Infrastructure ───────────────────────────────────
    DatabaseModule,
    SmsModule,
    WalletModule,
    MarketingSmsModule,
    SocketModule,
    EmailModule,

    // ── Operational ──────────────────────────────────────
    HealthModule,
    AdminModule,

    // ── Domain ───────────────────────────────────────────
    AuthModule,
    CustomerAuthModule,
    UsersModule,
    TenantsModule,
    BrandsModule,
    LocationsModule,
    TeamModule,
    LeadsModule,
    AgentModule,
    AlertsModule,
    MenusModule,
    SignageModule,
    TablesModule,
    ReservationsModule,
    CatalogModule,
    OrdersModule,
    IntegrationsModule,
    HubRiseModule,
    DeliverooModule,
    UberEatsModule,
    StuartModule,
    UberDirectModule,
    WebhooksModule,
    DispatchModule,
    ExpoPushModule,
    DriverAppModule,
    ChatModule,
    WhatsAppModule,
    UploadsModule,
    AnalyticsModule,
    KdsModule,
    LogsModule,
    PrintersModule,
    OrderingModule,
    StoreStatusModule,
    CustomersModule,
    DriversModule,
    PaymentsModule,
    BillingModule,
    VideoStudioModule,
    GroupOrdersModule,
    CustomerPushModule,
    VoiceModule,
    ReviewsModule,
    SubscriptionsModule,
    ContractsModule,
    NotificationsModule,
    SecurityModule,
    BrandingModule,
    ProviderRegistryModule,
    MobileModule,
    InventoryModule,
    MarketingModule,
    PauseModule,
    SandboxModule,
    OutboxModule,
    OnboardingModule,
    DeliveryZonesModule,
    PromoCodesModule,
    AddressLookupModule,
    DirectOrderingModule,
    SecretsModule,
    BrandConnectionsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: BillingGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
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
