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

  // Tap Payments (Gulf). The same secret key authorises API calls and signs
  // the webhook hashstring — there is no second webhook secret.
  tap: {
    secretKey: process.env.TAP_SECRET_KEY ?? "",
    apiBase: process.env.TAP_API_BASE ?? "https://api.tap.company/v2",
  },

  // Global fallback webhook secrets — per-tenant overrides are stored in the
  // integrations table and take precedence over these during signature verification.
  platforms: {
    uberEats: {
      clientId: process.env.UBER_EATS_CLIENT_ID ?? "",
      clientSecret: process.env.UBER_EATS_CLIENT_SECRET ?? "",
      webhookSecret: process.env.UBER_EATS_WEBHOOK_SECRET ?? "",
      baseUrl: process.env.UBER_EATS_BASE_URL ?? "https://api.uber.com/v2",
      // Phase UE — direct integration. The marketplace surface is rooted at
      // the bare host (…/v1/delivery/…, /v2/eats/…); baseUrl above is the
      // legacy HubRise-era default kept for the old webhook adapter.
      apiBase: process.env.UBER_EATS_API_BASE ?? "https://api.uber.com",
      authUrl: process.env.UBER_EATS_AUTH_URL ?? "https://auth.uber.com/oauth/v2",
      redirectUri:
        process.env.UBER_EATS_REDIRECT_URI ??
        `${(process.env.API_URL ?? "http://localhost:4000").replace(/\/$/, "")}/api/v1/integrations/ubereats/oauth/callback`,
    },
    deliveroo: {
      clientId: process.env.DELIVEROO_CLIENT_ID ?? "",
      clientSecret: process.env.DELIVEROO_CLIENT_SECRET ?? "",
      webhookSecret: process.env.DELIVEROO_WEBHOOK_SECRET ?? "",
      baseUrl: process.env.DELIVEROO_BASE_URL ?? "https://api.developers.deliveroo.com",
      authUrl:
        process.env.DELIVEROO_AUTH_URL ??
        "https://auth.developers.deliveroo.com/oauth2/token",
      // Deliveroo never reports a delivery to the merchant, so platform-
      // courier orders are closed by polling GET /order/v1/orders/{id}
      // (DeliverooOrderPollService). On by default; set
      // DELIVEROO_ORDER_POLL_ENABLED=false to stop it without a deploy.
      orderPollEnabled: process.env.DELIVEROO_ORDER_POLL_ENABLED !== "false",
    },
    justEat: {
      apiKey: process.env.JUST_EAT_API_KEY ?? "",
      webhookSecret: process.env.JUST_EAT_WEBHOOK_SECRET ?? "",
      baseUrl: process.env.JUST_EAT_BASE_URL ?? "https://uk.api.just-eat.io",
    },
    // Phase JE — direct Just Eat Takeaway (JET Connect, formerly Flyt).
    // Deliberately SEPARATE from the `justEat` block above, which belongs to
    // the pre-existing (unimplemented) generic webhook adapter. Nothing here
    // changes that path's behaviour.
    //
    // JET issues API KEYS, not OAuth clients, and the key you need depends on
    // what you're calling and for whom:
    //   - MENU key  — issued per COUNTRY, and separately for any brand over
    //                 6 locations. Used for /menus, /item-availability and
    //                 /restaurants/{ref}/*.
    //   - ORDER key — used for the async acknowledgement endpoints
    //                 (/order/{id}/sent-to-pos-success|failed).
    // So both are resolved brand → country → platform default by
    // JetCredentialResolver; these are the platform-default tier.
    //
    // JET_MENU_KEYS / JET_ORDER_KEYS hold the per-country tier as a
    // comma-separated "CC:key" list, e.g. "GB:abc123,IE:def456".
    jet: {
      menuApiKey: process.env.JET_MENU_API_KEY ?? "",
      orderApiKey: process.env.JET_ORDER_API_KEY ?? "",
      menuKeysByCountry: process.env.JET_MENU_KEYS ?? "",
      orderKeysByCountry: process.env.JET_ORDER_KEYS ?? "",
      defaultCountry: process.env.JET_DEFAULT_COUNTRY ?? "GB",
      // The shared secret JET signs inbound order webhooks with
      // (X-JET-Connect-Hash). Distinct from the API keys.
      webhookSecret: process.env.JET_WEBHOOK_SECRET ?? "",
      // The API key WE gave JET, which they present back to us in the
      // Authorization header on every inbound call. The four lifecycle
      // webhooks carry no HMAC, so this is their only authentication.
      inboundApiKey: process.env.JET_INBOUND_API_KEY ?? "",
      // Per-service hosts. Most operations sit on the platform base, but the
      // async acks and the amend/modification endpoints live on their own
      // service hosts.
      baseUrl: process.env.JET_API_BASE ?? "https://api.flytplatform.com",
      orderStatusUrl:
        process.env.JET_ORDER_STATUS_BASE ??
        "https://order-injection-status-updater.flyt-platform.com",
      orderingConnectorUrl:
        process.env.JET_ORDERING_CONNECTOR_BASE ??
        "https://ordering-universal-connector.flyt-platform.com",
      // JET marks an un-acked async order "failed to inject" after 3 minutes,
      // and a timeout counts against the order-injection SLA *and* skips the
      // backup flow. We force an explicit ack well before that.
      ackDeadlineSeconds: Number(process.env.JET_ACK_DEADLINE_SECONDS ?? 90),
      ackWatchdogEnabled: process.env.JET_ACK_WATCHDOG_ENABLED !== "false",
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
    // short/medium were missing here, so app.module.ts's
    // config.get("app.throttle.shortLimit") etc. always returned undefined
    // and the hardcoded fallbacks silently applied — the limits were NOT
    // actually env-tunable. Defaults mirror those fallbacks exactly
    // (short 120 req/s, medium 4000 req/min); behaviour is unchanged
    // until an env var is set in Render.
    shortTtl: parseInt(process.env.THROTTLE_SHORT_TTL ?? "1000", 10),
    shortLimit: parseInt(process.env.THROTTLE_SHORT_LIMIT ?? "120", 10),
    mediumTtl: parseInt(process.env.THROTTLE_MEDIUM_TTL ?? "60000", 10),
    mediumLimit: parseInt(process.env.THROTTLE_MEDIUM_LIMIT ?? "4000", 10),
    webhookTtl: parseInt(process.env.THROTTLE_WEBHOOK_TTL ?? "60000", 10),
    webhookLimit: parseInt(process.env.THROTTLE_WEBHOOK_LIMIT ?? "300", 10),
    loginTtl: parseInt(process.env.THROTTLE_LOGIN_TTL ?? "60000", 10),
    loginLimit: parseInt(process.env.THROTTLE_LOGIN_LIMIT ?? "10", 10),
  },
}));

export type AppConfig = ReturnType<typeof appConfig>;
