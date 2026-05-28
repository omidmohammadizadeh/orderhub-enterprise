-- ── Phase AJ — Location.printToken ───────────────────────────────────────────
-- Bearer token presented by the legacy Flutter printer app as `X-Print-Token`
-- when polling /v1/printer-jobs. Nullable for backward compatibility — the
-- new endpoint allows token-less polling until a token is set, after which
-- it strictly enforces the match.

ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "printToken" TEXT;

-- Unique partial index — multiple NULLs allowed, but each set token is unique.
CREATE UNIQUE INDEX IF NOT EXISTS "locations_printToken_key"
  ON "locations"("printToken")
  WHERE "printToken" IS NOT NULL;
