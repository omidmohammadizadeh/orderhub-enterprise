-- Phase AW-15 — Channel pauses (Stop Taking Orders + Busy Mode).
--
-- One row per active pause/busy scope. Granularity controlled by which
-- of locationId / brandId / channel are non-null. Idempotent.

CREATE TABLE IF NOT EXISTS "channel_pauses" (
  "id"            TEXT PRIMARY KEY,
  "locationId"    TEXT NOT NULL,
  "brandId"       TEXT,
  "channel"       TEXT,
  "mode"          TEXT NOT NULL DEFAULT 'paused',
  "resumeAt"      TIMESTAMP(3),
  "reason"        TEXT,
  "extraPrepTime" INTEGER,
  "pausedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "pausedBy"      TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "channel_pauses_locationId_idx"
  ON "channel_pauses" ("locationId");
CREATE INDEX IF NOT EXISTS "channel_pauses_brandId_idx"
  ON "channel_pauses" ("brandId");
CREATE INDEX IF NOT EXISTS "channel_pauses_channel_idx"
  ON "channel_pauses" ("channel");
CREATE INDEX IF NOT EXISTS "channel_pauses_locationId_resumeAt_idx"
  ON "channel_pauses" ("locationId", "resumeAt");

ALTER TABLE "channel_pauses"
  DROP CONSTRAINT IF EXISTS "channel_pauses_locationId_fkey";
ALTER TABLE "channel_pauses"
  ADD CONSTRAINT "channel_pauses_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE;
