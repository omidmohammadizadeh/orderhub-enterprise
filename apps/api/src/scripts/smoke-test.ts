/**
 * Production smoke test — verifies infrastructure connectivity and config without
 * touching real marketplace APIs or creating real orders/tickets.
 *
 * Defaults to --dry-run mode. All marketplace/printer/order operations are skipped
 * unless explicitly enabled via environment variables.
 *
 * Required environment variables:
 *   DATABASE_URL                            — Postgres connection string
 *   REDIS_URL (or QUEUE_REDIS_URL)          — Redis connection string
 *   CREDENTIAL_ENCRYPTION_KEY (or _CURRENT) — 64 hex chars
 *
 * Optional:
 *   SMOKE_BASE_URL        — base URL of the running API (default: http://localhost:4000)
 *   SMOKE_WEB_URL         — base URL of the web frontend (default: skipped)
 *   SMOKE_TENANT_ID       — tenantId for release-readiness and readiness score checks
 *   SMOKE_MIN_SCORE       — minimum acceptable release readiness score (default: 80)
 *   SMOKE_ALLOW_REAL_DATA — set to "true" to enable webhook/printer checks that hit live routes
 *   DRY_RUN               — set to "false" to disable dry-run (default: dry-run ON)
 *
 * Exit code 0 = all checks pass
 * Exit code 1 = at least one check failed
 */

import { PrismaClient } from "@orderhub/database";
import * as crypto from "crypto";
import * as http from "http";
import * as https from "https";
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment
const { createClient } = require("redis") as { createClient: (opts?: { url?: string }) => any };

// ── Helpers ───────────────────────────────────────────────────────────────────

type CheckStatus = "pass" | "fail" | "skip" | "warn";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  durationMs: number;
}

async function check(
  name: string,
  fn: () => Promise<void>,
  opts: { skip?: boolean; skipReason?: string; warnOnly?: boolean } = {},
): Promise<CheckResult> {
  if (opts.skip) {
    return { name, status: "skip", detail: opts.skipReason, durationMs: 0 };
  }

  const start = Date.now();
  try {
    await fn();
    return { name, status: "pass", durationMs: Date.now() - start };
  } catch (err: any) {
    const detail = err?.message ?? String(err);
    return {
      name,
      status: opts.warnOnly ? "warn" : "fail",
      detail,
      durationMs: Date.now() - start,
    };
  }
}

function httpGet(url: string, timeoutMs = 5000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request to ${url} timed out after ${timeoutMs}ms`));
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runSmokeTest(): Promise<void> {
  const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:4000";
  const webUrl = process.env.SMOKE_WEB_URL;
  const tenantId = process.env.SMOKE_TENANT_ID;
  const minScore = parseInt(process.env.SMOKE_MIN_SCORE ?? "80", 10);
  const dryRun = process.env.DRY_RUN !== "false";
  const allowRealData = process.env.SMOKE_ALLOW_REAL_DATA === "true";

  console.log("\n── OrderHub Smoke Test ─────────────────────────────────────────");
  console.log(`   Target:  ${baseUrl}`);
  console.log(`   Dry run: ${dryRun ? "ON (default)" : "OFF — real data checks enabled"}`);
  console.log(`   Tenant:  ${tenantId ?? "(not set — some checks skipped)"}`);
  console.log("────────────────────────────────────────────────────────────────\n");

  const results: CheckResult[] = [];
  const prisma = new PrismaClient();

  // ── 1. Encryption key present and valid ──────────────────────────────────

  results.push(await check("encryption_key_present", async () => {
    const key = process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT ?? process.env.CREDENTIAL_ENCRYPTION_KEY;
    if (!key) throw new Error("CREDENTIAL_ENCRYPTION_KEY (or _CURRENT) is not set");
    const buf = Buffer.from(key, "hex");
    if (buf.length !== 32) throw new Error(`Key is ${buf.length} bytes, expected 32`);
  }));

  // ── 2. Encryption roundtrip ───────────────────────────────────────────────

  results.push(await check("encryption_roundtrip", async () => {
    const key = process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT ?? process.env.CREDENTIAL_ENCRYPTION_KEY;
    if (!key) throw new Error("No key — skipping roundtrip");
    const keyBuf = Buffer.from(key, "hex");
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", keyBuf, iv);
    const ct = Buffer.concat([cipher.update("smoke-test-plaintext", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuf, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    if (plain !== "smoke-test-plaintext") throw new Error("Decrypted value does not match original");
  }));

  // ── 3. Database connectivity ──────────────────────────────────────────────

  results.push(await check("database_connection", async () => {
    await prisma.$queryRaw`SELECT 1`;
  }));

  // ── 4. Prisma can query the outbox table (confirms migration applied) ─────

  results.push(await check("outbox_table_accessible", async () => {
    await (prisma as any).outboxEvent.count();
  }));

  // ── 5. Phase K migration applied (LocationGoLiveStatus column exists) ─────

  results.push(await check("phase_k_migration_applied", async () => {
    // Query a location with the goLiveStatus field — will throw if column missing
    await prisma.location.findFirst({
      select: { id: true, goLiveStatus: true } as any,
    });
  }));

  // ── 6. Redis connectivity ─────────────────────────────────────────────────

  const redisUrl = process.env.REDIS_URL ?? process.env.QUEUE_REDIS_URL;
  results.push(await check("redis_connection", async () => {
    if (!redisUrl) throw new Error("REDIS_URL not set");
    const client = createClient({ url: redisUrl });
    client.on("error", () => {}); // suppress default error log
    await client.connect();
    const pong = await client.ping();
    await client.quit();
    if (pong !== "PONG") throw new Error(`Unexpected Redis PING response: ${pong}`);
  }));

  // ── 7. No plaintext credentials in database ───────────────────────────────

  results.push(await check("no_plaintext_credentials", async () => {
    const integrations = await prisma.integration.findMany({
      select: { id: true, credentials: true, platform: true },
    });

    const plaintext = integrations.filter((i) => {
      const creds = i.credentials as Record<string, unknown> | null;
      if (!creds || typeof creds !== "object") return false;
      // An encrypted envelope has "v", "alg", "iv", "tag", "ct" fields
      return !(creds.v && creds.alg && creds.iv && creds.ct);
    });

    if (plaintext.length > 0) {
      const ids = plaintext.map((i) => `${i.platform}:${i.id}`).join(", ");
      throw new Error(
        `${plaintext.length} integration(s) have plaintext credentials: ${ids}. Run the backfill script.`,
      );
    }
  }));

  // ── 8. No dead outbox events ──────────────────────────────────────────────

  results.push(await check("no_dead_outbox_events", async () => {
    const dead = await (prisma as any).outboxEvent.count({ where: { status: "DEAD" } });
    if (dead > 0) {
      throw new Error(
        `${dead} DEAD outbox event(s) found — investigate and reset before going live`,
      );
    }
  }));

  // ── 9. No stuck PROCESSING events ────────────────────────────────────────

  results.push(await check("no_stuck_processing_events", async () => {
    const timeoutSec = parseInt(process.env.OUTBOX_PROCESSING_TIMEOUT_SECONDS ?? "300", 10);
    const cutoff = new Date(Date.now() - timeoutSec * 1000);
    const stuck = await (prisma as any).outboxEvent.count({
      where: { status: "PROCESSING", updatedAt: { lt: cutoff } },
    });
    if (stuck > 0) {
      throw new Error(
        `${stuck} event(s) stuck in PROCESSING for >${timeoutSec}s — outbox dispatcher may be unhealthy`,
      );
    }
  }));

  // ── 10. API liveness ──────────────────────────────────────────────────────

  results.push(await check("api_liveness", async () => {
    const res = await httpGet(`${baseUrl}/api/v1/health`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.body.substring(0, 200)}`);
    const body = JSON.parse(res.body);
    if (body.status !== "ok") throw new Error(`Unexpected status: ${body.status}`);
  }));

  // ── 11. API readiness (DB + Redis) ────────────────────────────────────────

  results.push(await check("api_readiness", async () => {
    const res = await httpGet(`${baseUrl}/api/v1/health/ready`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = JSON.parse(res.body);
    if (body.checks?.database?.status !== "ok") {
      throw new Error(`Database check: ${body.checks?.database?.status ?? "missing"}`);
    }
  }));

  // ── 12. Sandbox disabled in production ────────────────────────────────────

  const isProductionTarget = baseUrl.includes("orderhub.io") ||
    process.env.NODE_ENV === "production";

  results.push(await check("sandbox_disabled_in_production", async () => {
    const res = await httpGet(`${baseUrl}/api/v1/health/ready`);
    const body = JSON.parse(res.body);
    if (isProductionTarget && body.environment === "production" && body.sandboxEnabled === true) {
      throw new Error("Sandbox tools are ENABLED on a production API — disable before serving real orders");
    }
  }, {
    warnOnly: !isProductionTarget,
  }));

  // ── 13. Release readiness score ───────────────────────────────────────────

  results.push(await check("release_readiness_score", async () => {
    if (!tenantId) throw new Error("SMOKE_TENANT_ID not set — skipping score check");
    const res = await httpGet(`${baseUrl}/api/v1/health/release-readiness?tenantId=${encodeURIComponent(tenantId)}`);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Readiness endpoint returned ${res.status} — check auth or use authenticated request`);
    }
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = JSON.parse(res.body);
    if (body.readyScore === undefined) throw new Error("Missing readyScore in response");
    if (body.readyScore < minScore) {
      throw new Error(`Release readiness score ${body.readyScore} is below minimum ${minScore}`);
    }
  }, {
    skip: !tenantId,
    skipReason: "SMOKE_TENANT_ID not set",
  }));

  // ── 14. Webhook endpoint reachable ────────────────────────────────────────

  results.push(await check("webhook_endpoint_reachable", async () => {
    const res = await httpGet(`${baseUrl}/api/v1/webhooks/unknown-platform/smoke-test-location`);
    // 400 = endpoint exists but rejected unknown platform (correct)
    // 404/502/503 = endpoint not registered or proxy error
    if (res.status === 404) throw new Error("Webhook route returned 404 — check route registration");
    if (res.status === 502 || res.status === 503) throw new Error(`Webhook route returned ${res.status} — API may not be running`);
  }));

  // ── 15. Web frontend reachable (optional) ────────────────────────────────

  results.push(await check("web_frontend_reachable", async () => {
    if (!webUrl) throw new Error("SMOKE_WEB_URL not set");
    const res = await httpGet(`${webUrl}`, 8000);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  }, {
    skip: !webUrl,
    skipReason: "SMOKE_WEB_URL not set",
    warnOnly: true,
  }));

  // ── 16. Printer jobs endpoint reachable ───────────────────────────────────

  results.push(await check("printer_jobs_endpoint_reachable", async () => {
    const res = await httpGet(`${baseUrl}/api/v1/printers/jobs/poll?shopCode=smoke-test`);
    // 401 = auth required (correct — endpoint exists)
    // 400 = validation error (correct — endpoint exists)
    // 404/502 = endpoint missing
    if (res.status === 404) throw new Error("Printer jobs poll endpoint returned 404 — check route registration");
    if (res.status === 502 || res.status === 503) throw new Error(`Printer endpoint returned ${res.status}`);
  }, {
    skip: !allowRealData,
    skipReason: "Set SMOKE_ALLOW_REAL_DATA=true to enable printer endpoint check",
    warnOnly: true,
  }));

  // ── Disconnect clients ────────────────────────────────────────────────────

  await prisma.$disconnect();

  // ── Report ────────────────────────────────────────────────────────────────

  const passed = results.filter((r) => r.status === "pass");
  const failed = results.filter((r) => r.status === "fail");
  const warned = results.filter((r) => r.status === "warn");
  const skipped = results.filter((r) => r.status === "skip");

  const STATUS_ICON: Record<CheckStatus, string> = {
    pass: "✓",
    fail: "✗",
    warn: "⚠",
    skip: "—",
  };

  console.log("── Results ─────────────────────────────────────────────────────");
  for (const r of results) {
    const icon = STATUS_ICON[r.status];
    const timing = r.durationMs > 0 ? `${r.durationMs}ms` : "  —  ";
    const detail = r.detail ? `  ← ${r.detail}` : "";
    console.log(`  ${icon}  ${r.name.padEnd(42)} ${timing.padStart(6)}${detail}`);
  }
  console.log("────────────────────────────────────────────────────────────────");
  console.log(
    `  ${passed.length} passed  |  ${failed.length} failed  |  ${warned.length} warnings  |  ${skipped.length} skipped`,
  );

  if (warned.length > 0) {
    console.log("\nWarnings:");
    for (const r of warned) console.log(`  ⚠  ${r.name}: ${r.detail}`);
  }

  if (failed.length > 0) {
    console.log("\nFailed:");
    for (const r of failed) console.log(`  ✗  ${r.name}: ${r.detail}`);
    console.log("\nSmoke test FAILED.\n");
    process.exit(1);
  }

  console.log("\nAll smoke test checks passed.\n");
}

runSmokeTest().catch((err) => {
  console.error("Smoke test crashed:", err.message);
  process.exit(1);
});
