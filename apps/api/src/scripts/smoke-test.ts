/**
 * Production smoke test — verifies infrastructure connectivity and config without
 * touching real marketplace APIs or creating real orders/tickets.
 *
 * Environment variables required:
 *   DATABASE_URL        — Postgres connection string
 *   REDIS_URL           — Redis connection string
 *   CREDENTIAL_ENCRYPTION_KEY (or _CURRENT) — 64 hex chars
 *
 * Optional:
 *   SMOKE_BASE_URL      — base URL of the running API (default: http://localhost:3000)
 *   SMOKE_TENANT_ID     — tenantId for release-readiness check
 *
 * Usage:
 *   DATABASE_URL=<url> REDIS_URL=<url> \
 *     CREDENTIAL_ENCRYPTION_KEY=<key> \
 *     SMOKE_BASE_URL=https://api.orderhub.example.com \
 *     npx ts-node -P apps/api/tsconfig.json apps/api/src/scripts/smoke-test.ts
 *
 * Exit code 0 = all checks pass
 * Exit code 1 = at least one check failed
 */

import { PrismaClient } from "@prisma/client";
import * as crypto from "crypto";
import * as http from "http";
import * as https from "https";

// ── Helpers ───────────────────────────────────────────────────────────────────

type CheckResult = { name: string; ok: boolean; detail?: string; durationMs: number };

async function check(name: string, fn: () => Promise<void>): Promise<CheckResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, ok: true, durationMs: Date.now() - start };
  } catch (err: any) {
    return { name, ok: false, detail: err?.message ?? String(err), durationMs: Date.now() - start };
  }
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

// ── Checks ────────────────────────────────────────────────────────────────────

async function runChecks(): Promise<void> {
  const results: CheckResult[] = [];
  const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
  const tenantId = process.env.SMOKE_TENANT_ID;

  // 1. Encryption key present
  results.push(await check("encryption_key_configured", async () => {
    const key = process.env.CREDENTIAL_ENCRYPTION_KEY_CURRENT ?? process.env.CREDENTIAL_ENCRYPTION_KEY;
    if (!key) throw new Error("CREDENTIAL_ENCRYPTION_KEY not set");
    const buf = Buffer.from(key, "hex");
    if (buf.length !== 32) throw new Error("Key must be 32 bytes (64 hex chars)");
  }));

  // 2. Encryption roundtrip
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
    if (plain !== "smoke-test-plaintext") throw new Error("Roundtrip mismatch");
  }));

  // 3. Database connectivity
  const prisma = new PrismaClient();
  results.push(await check("database_connection", async () => {
    await prisma.$queryRaw`SELECT 1`;
  }));

  // 4. Prisma can query the outbox table (confirms migration was applied)
  results.push(await check("outbox_table_exists", async () => {
    await prisma.outboxEvent.count();
  }));

  // 5. Prisma can query orders (confirms schema is generated)
  results.push(await check("orders_table_accessible", async () => {
    await prisma.order.count();
  }));

  // 6. API liveness endpoint
  results.push(await check("api_liveness", async () => {
    const res = await get(`${baseUrl}/api/v1/health`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = JSON.parse(res.body);
    if (body.status !== "ok") throw new Error(`status: ${body.status}`);
  }));

  // 7. API readiness endpoint (DB + Redis)
  results.push(await check("api_readiness", async () => {
    const res = await get(`${baseUrl}/api/v1/health/ready`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = JSON.parse(res.body);
    if (body.checks?.database?.status !== "ok") {
      throw new Error(`Database check: ${body.checks?.database?.status}`);
    }
  }));

  // 8. Release readiness endpoint (if tenantId provided)
  if (tenantId) {
    results.push(await check("release_readiness_endpoint", async () => {
      const res = await get(`${baseUrl}/api/v1/health/release-readiness?tenantId=${tenantId}`);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const body = JSON.parse(res.body);
      if (body.readyScore === undefined) throw new Error("Missing readyScore in response");
    }));
  }

  // 9. Webhook endpoint reachable (400 on unknown platform = endpoint is live)
  results.push(await check("webhook_endpoint_reachable", async () => {
    const res = await get(`${baseUrl}/api/v1/webhooks/unknown-platform/test-location`);
    // Expect 400 BadRequest for unknown platform, not 404/502
    if (res.status === 404 || res.status === 502 || res.status === 503) {
      throw new Error(`Unexpected HTTP ${res.status} — webhook endpoint may not be registered`);
    }
  }));

  await prisma.$disconnect();

  // ── Report ────────────────────────────────────────────────────────────────

  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log("\n── Smoke Test Results ──────────────────────────────────────");
  for (const r of results) {
    const icon = r.ok ? "✓" : "✗";
    const timing = `${r.durationMs}ms`;
    const detail = r.detail ? `  ← ${r.detail}` : "";
    console.log(`  ${icon}  ${r.name.padEnd(40)} ${timing}${detail}`);
  }
  console.log("────────────────────────────────────────────────────────────");
  console.log(`  ${passed.length}/${results.length} checks passed`);

  if (failed.length > 0) {
    console.log("\nFailed checks:");
    for (const r of failed) console.log(`  ✗  ${r.name}: ${r.detail}`);
    process.exit(1);
  }

  console.log("\nAll smoke tests passed.\n");
}

runChecks().catch((err) => {
  console.error("Smoke test crashed:", err.message);
  process.exit(1);
});
