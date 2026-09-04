-- The AI phone line writes orders with source/platform "VOICE".
--
-- Before this, voice-ai.service.ts passed "PHONE" — a value that exists in
-- neither enum. Prisma rejected the write, the create was caught, and the
-- caller was told the order could not be saved AFTER they had confirmed it.
-- Nothing ever reached the board.
--
-- ADD VALUE is not reversible in Postgres and the new value cannot be used in
-- the same transaction that adds it, so this migration only widens the types.
-- IF NOT EXISTS keeps it safe to re-run against an environment where the value
-- was added by hand.
ALTER TYPE "OrderPlatform" ADD VALUE IF NOT EXISTS 'VOICE';
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'VOICE';
