-- ── Phase AJ — Backfill missing metadata JSONB columns ──────────────────────
-- Many models in schema.prisma declare a `metadata Json @default("{}")`
-- column, but the original init migration only created `settings` JSONB on
-- the older entities (brands, locations, integrations) and skipped
-- `metadata`. Any code path that queries these tables via Prisma fails
-- with P2022 ("column does not exist") because the generated client
-- always SELECTs every declared column.
--
-- This migration adds the missing `metadata JSONB NOT NULL DEFAULT '{}'`
-- column to every table where the schema expects it. The fix is
-- idempotent — `ADD COLUMN IF NOT EXISTS` is a no-op when the column
-- already exists, so tables already correct are unaffected.
--
-- The DO-block wrapper additionally skips tables that don't exist
-- (e.g. if a model was removed from the schema after a migration).

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'tenants',
    'brands',
    'locations',
    'menu_items',
    'customers',
    'loyalty_accounts',
    'orders',
    'order_items',
    'order_status_history',
    'webhook_events',
    'printers',
    'drivers',
    'stripe_connect_accounts',
    'payments',
    'ledger_entries',
    'payouts',
    'suppliers',
    'ingredients',
    'stock_movements',
    'tenant_subscriptions',
    'usage_records',
    'daily_sales_snapshots',
    'provider_definitions',
    'webhook_routes'
  ];
BEGIN
  FOREACH t IN ARRAY tables
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I JSONB NOT NULL DEFAULT ''{}''',
        t,
        'metadata'
      );
    END IF;
  END LOOP;
END $$;
