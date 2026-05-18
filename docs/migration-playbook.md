# Migration Playbook

This document defines the rules for all Prisma schema changes in production.

## Development Workflow

In development, `prisma db push --force-reset` is acceptable because dev databases are throwaway. Never use `--force-reset` in staging or production.

The `packages/database` package runs `prisma generate` after every `db push` or `migrate dev` via the `postinstall`-style generate step built into the Prisma CLI.

---

## Naming Convention

Migration names must be descriptive and follow `snake_case`:

```
# Good
add_customer_search_columns_to_orders
add_composite_index_orders_location_status
drop_legacy_printer_model_column
add_soft_delete_to_integrations

# Bad
update
fix
migration_1
```

Generate with an explicit name:
```bash
cd packages/database
npx prisma migrate dev --name add_customer_search_columns_to_orders
```

---

## Additive-First Philosophy

**Every production migration must be additive or additive-then-remove.**

A migration is safe if applying it causes zero application downtime. The rules:

| Operation | Safe? | Notes |
|---|---|---|
| Add nullable column | Yes | Old code ignores new column |
| Add column with `@default` | Yes | Old code reads default |
| Add index | Yes | No table lock in Postgres for `CREATE INDEX CONCURRENTLY` |
| Add table | Yes | Nothing references it yet |
| Drop unused column | Yes | After two deploys: deploy code that stops using it, then migrate |
| Rename column | **No** | Two-step: add new column, dual-write, backfill, remove old |
| Add NOT NULL without default | **No** | Will fail if existing rows have null |
| Drop table | **No** | Requires prior code removal deploy |
| Change column type | **No** | Requires shadow column strategy |

---

## Zero-Downtime Migration Pattern

For operations that cannot be done in a single step, use the expand/contract pattern:

### Adding a required column

```
Step 1 — Expand:
  Add column as nullable: deletedAt DateTime?
  Deploy app code (now writes deletedAt)

Step 2 — Backfill:
  UPDATE table SET deletedAt = NULL WHERE deletedAt IS NULL  (already null, no-op)
  Or run a backfill script if the column needs a non-null default for existing rows

Step 3 — Contract (optional):
  If you need NOT NULL, add constraint AFTER verifying 100% of rows have values
```

### Renaming a column

```
Step 1 — Add new column, keep old
Step 2 — Dual-write both columns in application code
Step 3 — Backfill new column from old
Step 4 — Read from new column only
Step 5 — Remove old column
```

---

## Index Creation in Production

Postgres `CREATE INDEX` takes an `ACCESS SHARE` lock that blocks writes. Always use `CREATE INDEX CONCURRENTLY` for tables with live traffic.

Prisma's `@@index` directive generates a regular `CREATE INDEX`. For large tables in production:

1. **Do not** run `prisma migrate deploy` during peak hours for migrations that add indexes to large tables.
2. **Do** run the index creation manually using `CREATE INDEX CONCURRENTLY` before the migration, then run `prisma migrate deploy` (which will detect the index already exists and skip).
3. **Do** schedule index maintenance (e.g., `REINDEX CONCURRENTLY`) during off-peak hours.

---

## Production Migration Procedure

```bash
# 1. Apply to staging first
DATABASE_URL=postgres://...staging... npx prisma migrate deploy

# 2. Verify staging is healthy (run smoke tests, check error rates)

# 3. Take a manual snapshot / backup

# 4. Apply to production
DATABASE_URL=postgres://...production... npx prisma migrate deploy

# 5. Verify production (order flow end-to-end test, check dashboards)
```

Never run `prisma migrate dev` against staging or production — it creates and applies an unnamed migration, which is non-reproducible.

---

## Rollback Strategy

Prisma does not support automatic rollback of applied migrations. Rollback options:

### Option A: Forward-fix migration (preferred)

Write a new migration that reverses the change. This keeps the migration history linear and audit-friendly.

```bash
npx prisma migrate dev --name revert_add_problematic_column
```

### Option B: Database restore

For catastrophic failures only. Requires a pre-migration snapshot. Recovery time depends on database size and RTO requirements.

Never attempt to manually delete rows from `_prisma_migrations` or edit migration SQL files after they have been applied to any environment. Prisma uses SHA-256 checksums to detect tampering.

---

## Checklist Before Every Production Migration

- [ ] Migration applied and tested on staging
- [ ] Migration name is descriptive and follows naming convention
- [ ] All new columns are nullable or have a `@default` value
- [ ] If adding indexes to large tables, confirm `CONCURRENTLY` approach
- [ ] Application code is backwards-compatible with both old and new schema
- [ ] Database backup taken within last 24 hours
- [ ] On-call engineer available for 30 minutes after deploy
- [ ] Rollback plan documented (forward-fix migration ready or restore tested)
