import { z } from "zod";

// ── Environment schema ─────────────────────────────────────────────────────
// Validated at boot time. Missing required vars → process.exit(1) with a
// clear message listing every missing variable. Never starts with partial config.

const envSchema = z.object({
  // Core
  NODE_ENV: z.enum(["local", "development", "staging", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  // Render's fromService can only provide a bare hostname (no protocol).
  // Preprocess: if no protocol is present, assume https:// (safe default for cloud).
  // Local dev values like "http://localhost:3000" are left unchanged.
  APP_URL: z
    .preprocess(
      (v) => (typeof v === "string" && v && !v.includes("://") ? `https://${v}` : v),
      z.string().url(),
    )
    .default("http://localhost:3000"),
  API_URL: z
    .preprocess(
      (v) => (typeof v === "string" && v && !v.includes("://") ? `https://${v}` : v),
      z.string().url(),
    )
    .default("http://localhost:4000"),
  WEB_URL: z.string().url().optional(),
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_POOL_MIN: z.coerce.number().int().positive().default(2),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Redis
  REDIS_URL: z.string().min(1, "REDIS_URL is required").default("redis://localhost:6379"),
  QUEUE_REDIS_URL: z.string().min(1, "QUEUE_REDIS_URL is required").default("redis://localhost:6379"),
  REDIS_PASSWORD: z.string().optional(),

  // Auth
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  // Long-lived by design: operators expect the POS/dashboard to stay signed
  // in until they explicitly log out. Rotation slides the expiry on every
  // refresh, so this means "log out after a year of NO use", not a fixed cap.
  JWT_REFRESH_TTL: z.string().default("365d"),

  // Caller-ID: shared secret for VoIP providers' incoming-call webhooks
  // (POST /v1/customers/caller-id/voip/:locationId?key=…). Unset = endpoint
  // disabled (403) so it can never be an open relay.
  VOIP_WEBHOOK_KEY: z.string().optional(),

  // Stripe Terminal "test drive": a TEST-mode key used ONLY for simulated
  // card readers (Stripe refuses simulated readers on live keys). Real
  // readers + all other payments keep using STRIPE_SECRET_KEY.
  STRIPE_TEST_SECRET_KEY: z.string().optional(),

  // Encryption — Phase I primary key (still accepted; superseded by _CURRENT in Phase J)
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "ENCRYPTION_KEY must be a 64-char hex string (32 bytes)")
    .optional(),

  // Credential encryption (Phase J) — preferred over ENCRYPTION_KEY in production
  CREDENTIAL_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "CREDENTIAL_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)")
    .optional(),
  CREDENTIAL_ENCRYPTION_KEY_CURRENT: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "CREDENTIAL_ENCRYPTION_KEY_CURRENT must be a 64-char hex string")
    .optional(),
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS must be a 64-char hex string")
    .optional(),
  CREDENTIAL_ENCRYPTION_KEY_ID: z.string().default("v1"),

  // Outbox dispatcher tuning
  OUTBOX_PROCESSING_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),

  // Stripe
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),

  // Tap Payments — the Gulf money path. One key does everything: it
  // authorises the API calls AND signs the webhook `hashstring`, so there is
  // no separate webhook secret to set (or to forget) the way Stripe has.
  //
  // Optional, like Stripe's: a deployment with no Gulf shops needs neither,
  // and a Gulf shop without it is told at checkout that the restaurant
  // doesn't take cards yet rather than 500-ing mid-payment.
  TAP_SECRET_KEY: z.string().optional(),
  // Override only for Tap's sandbox or a proxy. Defaults to the live base.
  TAP_API_BASE: z.string().url().optional(),


  // Platform webhook secrets (per-tenant overrides stored in DB; these are fallback globals)
  UBER_EATS_CLIENT_ID: z.string().optional(),
  UBER_EATS_CLIENT_SECRET: z.string().optional(),
  UBER_EATS_WEBHOOK_SECRET: z.string().optional(),
  UBER_EATS_BASE_URL: z.string().url().default("https://api.uber.com/v2"),
  UBER_EATS_API_BASE: z.string().url().default("https://api.uber.com"),
  UBER_EATS_AUTH_URL: z.string().url().default("https://auth.uber.com/oauth/v2"),
  UBER_EATS_REDIRECT_URI: z.string().url().optional(),

  DELIVEROO_CLIENT_ID: z.string().optional(),
  DELIVEROO_CLIENT_SECRET: z.string().optional(),
  DELIVEROO_WEBHOOK_SECRET: z.string().optional(),
  DELIVEROO_BASE_URL: z.string().url().default("https://api.developers.deliveroo.com"),

  JUST_EAT_API_KEY: z.string().optional(),
  JUST_EAT_WEBHOOK_SECRET: z.string().optional(),
  JUST_EAT_BASE_URL: z.string().url().default("https://uk.api.just-eat.io"),

  // Phase JE — direct Just Eat Takeaway (JET Connect / Flyt). All optional so
  // deploys without JET enabled still boot. See app.config.ts `jet` for what
  // each one is and why menu/order keys are separate.
  JET_MENU_API_KEY: z.string().optional(),
  JET_ORDER_API_KEY: z.string().optional(),
  JET_MENU_KEYS: z.string().optional(),
  JET_ORDER_KEYS: z.string().optional(),
  JET_DEFAULT_COUNTRY: z.string().optional(),
  JET_WEBHOOK_SECRET: z.string().optional(),
  JET_INBOUND_API_KEY: z.string().optional(),
  JET_API_BASE: z.string().url().optional(),
  JET_ORDER_STATUS_BASE: z.string().url().optional(),
  JET_ORDERING_CONNECTOR_BASE: z.string().url().optional(),
  JET_ACK_DEADLINE_SECONDS: z.coerce.number().optional(),
  JET_ACK_WATCHDOG_ENABLED: z.string().optional(),

  // Phase AU — HubRise OAuth client credentials. Either the legacy
  // HUBRISE_APP_* names or the new HUBRISE_CLIENT_* names work; the
  // app config resolves whichever is set. Optional so deploys without
  // HubRise enabled still boot.
  HUBRISE_APP_ID: z.string().optional(),
  HUBRISE_APP_SECRET: z.string().optional(),
  HUBRISE_CLIENT_ID: z.string().optional(),
  HUBRISE_CLIENT_SECRET: z.string().optional(),
  HUBRISE_BASE_URL: z.string().url().optional(),
  HUBRISE_OAUTH_AUTHORIZE_URL: z.string().url().optional(),
  HUBRISE_OAUTH_TOKEN_URL: z.string().url().optional(),
  HUBRISE_REDIRECT_URI: z.string().url().optional(),
  HUBRISE_WEBHOOK_SECRET: z.string().optional(),

  // Email
  RESEND_API_KEY: z.string().optional(),
  // Phase AR — orderhubsolutions.com is the verified sender on the
  // production Resend account. Sending from anywhere else (including
  // the legacy orderhub.io default) gets a 403 "API key is not
  // authorized to send emails from <domain>".
  EMAIL_FROM: z
    .string()
    .default("Order Hub <hello@orderhubsolutions.com>"),
  // Where "a merchant's subscription payment failed" alerts go on our side.
  // Unset just means that half of the notification is skipped (logged, not
  // sent) — the client still gets theirs.
  BILLING_ALERT_EMAIL: z.string().email().optional(),

  // Socket.IO
  SOCKET_CORS_ORIGIN: z.string().default("http://localhost:3000"),
  SOCKET_MAX_CONNECTIONS_PER_LOCATION: z.coerce.number().int().positive().default(100),

  // Logging & Observability
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug", "verbose"]).default("info"),
  SENTRY_DSN: z.string().url().optional(),
  DATADOG_API_KEY: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default("orderhub-api"),

  // Feature Flags
  ENABLE_ANALYTICS: z.coerce.boolean().default(true),
  ENABLE_DISPATCH: z.coerce.boolean().default(true),
  ENABLE_KDS: z.coerce.boolean().default(true),
  ENABLE_MAINTENANCE_MODE: z.coerce.boolean().default(false),
  MAINTENANCE_MESSAGE: z.string().optional(),

  // Rate limiting overrides
  THROTTLE_SHORT_TTL: z.coerce.number().int().positive().default(1000),
  THROTTLE_SHORT_LIMIT: z.coerce.number().int().positive().default(120),
  THROTTLE_MEDIUM_TTL: z.coerce.number().int().positive().default(60000),
  THROTTLE_MEDIUM_LIMIT: z.coerce.number().int().positive().default(4000),
  THROTTLE_WEBHOOK_TTL: z.coerce.number().int().positive().default(60000),
  THROTTLE_WEBHOOK_LIMIT: z.coerce.number().int().positive().default(300),
  THROTTLE_LOGIN_TTL: z.coerce.number().int().positive().default(60000),
  THROTTLE_LOGIN_LIMIT: z.coerce.number().int().positive().default(10),
});

export type Env = z.infer<typeof envSchema>;

// ── Insecure default patterns to reject in production ─────────────────────────

const INSECURE_PATTERNS: Array<[keyof Env, string]> = [
  ["JWT_SECRET",         "change-me"],
  ["JWT_SECRET",         "secret"],
  ["JWT_SECRET",         "password"],
  ["JWT_REFRESH_SECRET", "change-me"],
  ["JWT_REFRESH_SECRET", "secret"],
  ["JWT_REFRESH_SECRET", "password"],
];

const ZERO_PATTERN = /^0+$/;

// ── Validation ────────────────────────────────────────────────────────────────

export function validateEnv(rawEnv: Record<string, unknown>): Env {
  const result = envSchema.safeParse(rawEnv);

  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");

    console.error(
      `\n❌  Environment validation failed. Fix the following before starting:\n\n${errors}\n`,
    );
    process.exit(1);
    return {} as Env; // unreachable in production; guards against mocked exit in tests
  }

  const env = result.data;

  if (env.NODE_ENV === "production") {
    const productionErrors: string[] = [];

    // At least one credential encryption key must be set
    const hasEncKey = !!(
      env.CREDENTIAL_ENCRYPTION_KEY_CURRENT ??
      env.CREDENTIAL_ENCRYPTION_KEY ??
      env.ENCRYPTION_KEY
    );
    if (!hasEncKey) {
      productionErrors.push(
        "CREDENTIAL_ENCRYPTION_KEY (or CREDENTIAL_ENCRYPTION_KEY_CURRENT) is required in production",
      );
    }

    // Reject all-zero keys
    if (env.CREDENTIAL_ENCRYPTION_KEY && ZERO_PATTERN.test(env.CREDENTIAL_ENCRYPTION_KEY)) {
      productionErrors.push("CREDENTIAL_ENCRYPTION_KEY must not be all zeros");
    }
    if (env.CREDENTIAL_ENCRYPTION_KEY_CURRENT && ZERO_PATTERN.test(env.CREDENTIAL_ENCRYPTION_KEY_CURRENT)) {
      productionErrors.push("CREDENTIAL_ENCRYPTION_KEY_CURRENT must not be all zeros");
    }

    // Reject known-insecure JWT values
    for (const [key, pattern] of INSECURE_PATTERNS) {
      const value = env[key] as string | undefined;
      if (value && value.toLowerCase().includes(pattern)) {
        productionErrors.push(`${key} contains insecure default value ("${pattern}") — regenerate with: openssl rand -base64 48`);
      }
    }

    // Warn (non-fatal) about localhost CORS in production
    const corsOrigin = env.SOCKET_CORS_ORIGIN ?? "";
    if (corsOrigin.includes("localhost") || corsOrigin === "*") {
      console.warn(
        `\n⚠️   SOCKET_CORS_ORIGIN is "${corsOrigin}" — set to your production frontend domain before going live.\n`,
      );
    }

    // APP_URL must not be localhost in production
    if (env.APP_URL.includes("localhost")) {
      productionErrors.push(
        `APP_URL is "${env.APP_URL}" — set to the production frontend URL in production`,
      );
    }

    if (productionErrors.length > 0) {
      console.error(
        `\n❌  Production safety checks failed:\n\n${productionErrors.map((e) => `  - ${e}`).join("\n")}\n`,
      );
      process.exit(1);
    }
  }

  return env;
}
