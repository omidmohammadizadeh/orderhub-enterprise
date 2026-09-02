import "reflect-metadata";
import { NestFactory, HttpAdapterHost } from "@nestjs/core";
import { ValidationPipe, VersioningType } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { NestExpressApplication } from "@nestjs/platform-express";
import { IoAdapter } from "@nestjs/platform-socket.io";
import helmet from "helmet";
import compression from "compression";
import { WinstonModule } from "nest-winston";
import { AppModule } from "./app.module";
import { LoggingExceptionFilter } from "./common/filters/logging-exception.filter";
import { winstonConfig } from "./config/logger.config";
import { PrismaService } from "./infrastructure/database/prisma.service";
import { createCorsOriginCheck } from "./config/cors.config";

async function bootstrap() {
  const logger = WinstonModule.createLogger(winstonConfig);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger,
    bufferLogs: false, // false = log immediately; true would suppress all output until app.listen()
    rawBody: true, // Required for webhook HMAC signature verification
  });

  // ── Graceful shutdown ───────────────────────────────────
  // SIGTERM is sent by Kubernetes/Docker during rolling deploys.
  // enableShutdownHooks allows OnModuleDestroy lifecycle methods to run,
  // draining in-flight requests and closing DB/Redis connections cleanly.
  app.enableShutdownHooks();

  // ── Trust the platform proxy ────────────────────────────
  // Render terminates TLS and forwards requests, so without this Express
  // reports the proxy's IP for every request — which makes the rate limiter
  // (ThrottlerGuard keys on req.ip) bucket EVERY client together and return
  // 429s once total platform traffic exceeds one shared limit. Trusting the
  // first hop makes req.ip the real client IP from X-Forwarded-For, so limits
  // apply per restaurant, and also fixes https detection behind the proxy.
  app.set("trust proxy", 1);

  // ── Security ────────────────────────────────────────────
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false, // Required for Swagger UI
      // helmet's default Cross-Origin-Resource-Policy: same-origin makes
      // browsers BLOCK <img> loads of API-served images from the web app's
      // domain (net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin) — hubrise-image
      // proxy, storefronts on custom domains, etc. The API serves public
      // images by design; allow cross-origin embedding.
      crossOriginResourcePolicy: { policy: "cross-origin" },
      contentSecurityPolicy:
        process.env.NODE_ENV === "production" ? undefined : false,
    }),
  );
  app.use(compression());

  // ── Body parser limit ────────────────────────────────────
  // Phase AL: product create/update payloads include a base64-encoded
  // image (Supabase Storage upload lands in the follow-up). Express's
  // default 100 KB limit rejects every product image as 413 "Payload
  // Too Large". Lift to 10 MB to comfortably hold a resized 1064×768
  // JPEG (~150 KB) plus the rest of the form. Once real Supabase URLs
  // replace the data URLs, this can drop back to 1 MB.
  app.useBodyParser("json", { limit: "10mb" });
  app.useBodyParser("urlencoded", { limit: "10mb", extended: true });

  // ── CORS ────────────────────────────────────────────────
  // CORS_ALLOWED_ORIGINS (comma-separated) takes precedence; falls back to APP_URL.
  // Render's fromService.property:host returns the bare internal hostname (e.g.
  // "orderhub-web"), not the public URL. Set CORS_ALLOWED_ORIGINS explicitly in
  // render.yaml to the real public URL (https://orderhub-web.onrender.com).
  const rawCorsOrigins =
    process.env.CORS_ALLOWED_ORIGINS ??
    process.env.APP_URL ??
    "http://localhost:3000";
  const allowedOrigins = rawCorsOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  // Brand custom domains are storefronts we serve, but they're operator-
  // managed and can't be baked into an env var — see cors.config.ts for why a
  // refusal must never throw.
  const prismaForCors = app.get(PrismaService);
  const cors = createCorsOriginCheck({
    allowedOrigins,
    loadCustomDomains: async () => {
      const rows = await prismaForCors.brand.findMany({
        where: { customDomain: { not: null }, deletedAt: null },
        select: { customDomain: true },
      });
      return rows.map((r) => r.customDomain ?? "");
    },
  });
  await cors.warm().catch((err) =>
    logger.warn?.(`CORS: could not load brand custom domains — ${err.message}`),
  );

  app.enableCors({
    origin: cors.origin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-tenant-id", "x-request-id"],
  });

  // ── API Versioning ───────────────────────────────────────
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  app.setGlobalPrefix("api");

  // ── Error logging ───────────────────────────────────────
  // Guards run before interceptors, so LoggingInterceptor never saw a single
  // 401/403/429 — those requests vanished from the log entirely.
  app.useGlobalFilters(
    new LoggingExceptionFilter(app.get(HttpAdapterHost).httpAdapter),
  );

  // ── Validation ──────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // ── WebSockets ──────────────────────────────────────────
  app.useWebSocketAdapter(new IoAdapter(app));

  // ── Swagger (non-production only) ───────────────────────
  if (process.env.NODE_ENV !== "production") {
    const config = new DocumentBuilder()
      .setTitle("OrderHub API")
      .setDescription("Omnichannel restaurant integration platform")
      .setVersion("1.0")
      .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT" })
      .addApiKey({ type: "apiKey", in: "header", name: "x-api-key" }, "ApiKey")
      .addServer("http://localhost:4000", "Local")
      .addServer("https://api-staging.orderhub.io", "Staging")
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("docs", app, document, {
      swaggerOptions: { persistAuthorization: true },
    });

    logger.log("Swagger UI: http://localhost:4000/docs", "Bootstrap");
  }

  const port = parseInt(process.env.PORT ?? "4000", 10);
  await app.listen(port, "0.0.0.0"); // bind to all interfaces for Docker
  logger.log(`API running on port ${port} [${process.env.NODE_ENV}]`, "Bootstrap");
}

bootstrap().catch((err) => {
  console.error("Fatal error during bootstrap:", err);
  process.exit(1);
});
