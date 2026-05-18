import { z } from "zod";

// ── Environment schema ─────────────────────────────────────────────────────
// Validated at boot time. Missing required vars → process.exit(1) with a
// clear message listing every missing variable. Never starts with partial config.

const envSchema = z.object({
  // Core
  NODE_ENV: z.enum(["local", "development", "staging", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url().default("http://localhost:3000"),
  API_URL: z.string().url().default("http://localhost:4000"),

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
  JWT_REFRESH_TTL: z.string().default("7d"),

  // Encryption (32-byte hex = 64 chars)
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "ENCRYPTION_KEY must be a 64-char hex string (32 bytes)"),

  // Stripe
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),

  // Platform webhook secrets (per-tenant overrides stored in DB; these are fallback globals)
  UBER_EATS_CLIENT_ID: z.string().optional(),
  UBER_EATS_CLIENT_SECRET: z.string().optional(),
  UBER_EATS_WEBHOOK_SECRET: z.string().optional(),
  UBER_EATS_BASE_URL: z.string().url().default("https://api.uber.com/v2"),

  DELIVEROO_CLIENT_ID: z.string().optional(),
  DELIVEROO_CLIENT_SECRET: z.string().optional(),
  DELIVEROO_WEBHOOK_SECRET: z.string().optional(),
  DELIVEROO_BASE_URL: z.string().url().default("https://api.developers.deliveroo.com"),

  JUST_EAT_API_KEY: z.string().optional(),
  JUST_EAT_WEBHOOK_SECRET: z.string().optional(),
  JUST_EAT_BASE_URL: z.string().url().default("https://uk.api.just-eat.io"),

  HUBRISE_APP_ID: z.string().optional(),
  HUBRISE_APP_SECRET: z.string().optional(),

  // Email
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("OrderHub <noreply@orderhub.io>"),

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
  THROTTLE_WEBHOOK_TTL: z.coerce.number().int().positive().default(60000),
  THROTTLE_WEBHOOK_LIMIT: z.coerce.number().int().positive().default(300),
  THROTTLE_LOGIN_TTL: z.coerce.number().int().positive().default(60000),
  THROTTLE_LOGIN_LIMIT: z.coerce.number().int().positive().default(10),
});

export type Env = z.infer<typeof envSchema>;

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
  }

  // Warn about insecure defaults in production
  if (result.data.NODE_ENV === "production") {
    const insecurePatterns = [
      ["JWT_SECRET", result.data.JWT_SECRET, "change-me"],
      ["JWT_REFRESH_SECRET", result.data.JWT_REFRESH_SECRET, "change-me"],
      ["ENCRYPTION_KEY", result.data.ENCRYPTION_KEY, "000000"],
    ] as const;

    for (const [key, value, pattern] of insecurePatterns) {
      if (value.includes(pattern)) {
        console.error(`\n❌  Production safety: ${key} contains insecure default value.\n`);
        process.exit(1);
      }
    }
  }

  return result.data;
}
