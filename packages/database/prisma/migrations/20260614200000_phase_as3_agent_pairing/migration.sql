-- Phase AS-3 — Agent pairing + device identity.
--
-- Pairing flow:
--   1. Operator clicks "Pair new device" on the dashboard.
--   2. Server creates an AgentPairCode row, 6-character human-readable
--      code + 10-minute TTL. Dashboard shows it as a QR + text.
--   3. Agent (binary) reads the QR or the operator types the code.
--      POSTs to /v1/print-agents/pair with { code, deviceId,
--      deviceName, hostname, osType, versionString }.
--   4. Server verifies the code is unused and unexpired, creates a
--      PrintAgent row, returns the agent id + plaintext token.
--
-- deviceId is the UUID the agent generates locally on first boot and
-- caches in its config file. Re-running the binary with the same
-- config reuses the same agent record (idempotent install).

CREATE TABLE "agent_pair_codes" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "locationId"  TEXT NOT NULL,
  "code"        TEXT NOT NULL,
  "createdById" TEXT,
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  "usedAt"      TIMESTAMP(3),
  "agentId"     TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_pair_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_pair_codes_code_key" ON "agent_pair_codes"("code");
CREATE INDEX "agent_pair_codes_tenantId_idx" ON "agent_pair_codes"("tenantId");
CREATE INDEX "agent_pair_codes_expiresAt_idx" ON "agent_pair_codes"("expiresAt");
ALTER TABLE "agent_pair_codes"
  ADD CONSTRAINT "agent_pair_codes_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "agent_pair_codes"
  ADD CONSTRAINT "agent_pair_codes_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE;
ALTER TABLE "agent_pair_codes"
  ADD CONSTRAINT "agent_pair_codes_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "agent_pair_codes"
  ADD CONSTRAINT "agent_pair_codes_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "print_agents"("id") ON DELETE SET NULL;

-- PrintAgent: device identity + monitoring columns.
ALTER TABLE "print_agents"
  ADD COLUMN IF NOT EXISTS "deviceId"   TEXT,
  ADD COLUMN IF NOT EXISTS "deviceName" TEXT,
  ADD COLUMN IF NOT EXISTS "osType"     TEXT,
  ADD COLUMN IF NOT EXISTS "hostname"   TEXT,
  ADD COLUMN IF NOT EXISTS "printerCount" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "print_agents_deviceId_key"
  ON "print_agents"("deviceId")
  WHERE "deviceId" IS NOT NULL;
