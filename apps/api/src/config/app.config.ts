import { registerAs } from "@nestjs/config";

export const appConfig = registerAs("app", () => ({
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parseInt(process.env.PORT ?? "4000", 10),
  appUrl: process.env.APP_URL ?? "http://localhost:3000",
  apiUrl: process.env.API_URL ?? "http://localhost:4000",
  isProduction: process.env.NODE_ENV === "production",
  isTest: process.env.NODE_ENV === "test",

  jwt: {
    secret: process.env.JWT_SECRET!,
    refreshSecret: process.env.JWT_REFRESH_SECRET!,
    accessTtl: process.env.JWT_ACCESS_TTL ?? "15m",
    refreshTtl: process.env.JWT_REFRESH_TTL ?? "365d",
  },

  encryptionKey: process.env.ENCRYPTION_KEY!,

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "",
  },

  // Global fallback webhook secrets — per-tenant overrides are stored in the
  // integrations table and take precedence over these during signature verification.
  platforms: {
    uberEats: {
      clientId: process.env.UBER_EATS_CLIENT_ID ?? "",
      clientSecret: process.env.UBER_EATS_CLIENT_SECRET ?? "",
      webhookSecret: process.env.UBER_EATS_WEBHOOK_SECRET ?? "",
      baseUrl: process.env.UBER_EATS_BASE_URL ?? "https://api.uber.com/v2",
    },
    deliveroo: {
      clientId: process.env.DELIVEROO_CLIENT_ID ?? "",
      clientSecret: process.env.DELIVEROO_CLIENT_SECRET ?? "",
      webhookSecret: process.env.DELIVEROO_WEBHOOK_SECRET ?? "",
      baseUrl: process.env.DELIVEROO_BASE_URL ?? "https://api.developers.deliveroo.com",
      authUrl:
        process.env.DELIVEROO_AUTH_URL ??
        "https://auth.developers.deliveroo.com/oauth2/token",
    },
    justEat: {
      apiKey: process.env.JUST_EAT_API_KEY ?? "",
      webhookSecret: process.env.JUST_EAT_WEBHOOK_SECRET ?? "",
      baseUrl: process.env.JUST_EAT_BASE_URL ?? "https://uk.api.just-eat.io",
    },
    hubrise: {
      // Phase AU — HubRise OAuth client. HubRise's dashboard calls
      // these "Application ID" and "Application Secret"; the OAuth
      // spec calls them client_id / client_secret. Same values.
      //
      // appId / appSecret stay readable from either env var name so
      // existing deploys with the older naming don't break.
      appId:
        process.env.HUBRISE_CLIENT_ID ??
        process.env.HUBRISE_APP_ID ??
        "",
      appSecret:
        process.env.HUBRISE_CLIENT_SECRET ??
        process.env.HUBRISE_APP_SECRET ??
        "",
      // OAuth + REST endpoints. Defaulted so a fresh deploy doesn't
      // need to set them — only override for sandbox / staging.
      baseUrl: process.env.HUBRISE_BASE_URL ?? "https://api.hubrise.com/v1",
      oauthAuthorizeUrl:
        process.env.HUBRISE_OAUTH_AUTHORIZE_URL ??
        "https://manager.hubrise.com/oauth2/v1/authorize",
      oauthTokenUrl:
        process.env.HUBRISE_OAUTH_TOKEN_URL ??
        "https://manager.hubrise.com/oauth2/v1/token",
      // Where HubRise redirects after the operator approves the
      // OAuth consent. Must match what we registered in the HubRise
      // app config. Defaulted to the prod API host; staging deploys
      // override.
      redirectUri:
        process.env.HUBRISE_REDIRECT_URI ??
        "https://orderhub-api-0re6.onrender.com/api/v1/integrations/hubrise/callback",
      // Shared secret used to verify the X-Hubrise-Signature header
      // on inbound webhooks. Optional — when blank we accept all
      // signatures (dev convenience) but log a warning each time.
      webhookSecret: process.env.HUBRISE_WEBHOOK_SECRET ?? "",
    },
  },

  email: {
    resendApiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.EMAIL_FROM ?? "Order Hub <hello@orderhubsolutions.com>",
  },

  socket: {
    corsOrigin: process.env.SOCKET_CORS_ORIGIN ?? "http://localhost:3000",
    maxConnectionsPerLocation: parseInt(
      process.env.SOCKET_MAX_CONNECTIONS_PER_LOCATION ?? "100",
      10,
    ),
  },

  observability: {
    logLevel: process.env.LOG_LEVEL ?? "info",
    sentryDsn: process.env.SENTRY_DSN ?? "",
    datadogApiKey: process.env.DATADOG_API_KEY ?? "",
    otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "",
    otelServiceName: process.env.OTEL_SERVICE_NAME ?? "orderhub-api",
  },

  features: {
    analytics: process.env.ENABLE_ANALYTICS !== "false",
    dispatch: process.env.ENABLE_DISPATCH !== "false",
    kds: process.env.ENABLE_KDS !== "false",
    maintenanceMode: process.env.ENABLE_MAINTENANCE_MODE === "true",
    maintenanceMessage:
      process.env.MAINTENANCE_MESSAGE ?? "The system is temporarily down for maintenance.",
  },

  throttle: {
    webhookTtl: parseInt(process.env.THROTTLE_WEBHOOK_TTL ?? "60000", 10),
    webhookLimit: parseInt(process.env.THROTTLE_WEBHOOK_LIMIT ?? "300", 10),
    loginTtl: parseInt(process.env.THROTTLE_LOGIN_TTL ?? "60000", 10),
    loginLimit: parseInt(process.env.THROTTLE_LOGIN_LIMIT ?? "10", 10),
  },
}));

export type AppConfig = ReturnType<typeof appConfig>;
