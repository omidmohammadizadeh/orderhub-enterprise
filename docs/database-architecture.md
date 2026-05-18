# Database Architecture

OrderHub uses PostgreSQL via Prisma ORM. The schema is in `packages/database/prisma/schema.prisma`. The Prisma client is generated to `packages/database/generated/prisma` to avoid type-resolution failures with pnpm symlinks.

## Design Principles

### Cascade Policy

Every foreign key has an explicit `onDelete` directive — nothing is left to database defaults.

| Pattern | When used | Rationale |
|---|---|---|
| `Cascade` | Child records have no meaning without the parent (e.g., `KdsTicket → KdsScreen`) | Deleting the screen should clear its tickets |
| `Restrict` | Deleting the parent would destroy operational history (e.g., `Order → Tenant`) | Prevents accidental data loss; the parent must be deactivated, not deleted |
| `SetNull` | Optional reference that survives parent deletion (e.g., `PrintJob → Printer`) | Print job history remains even if the printer is deprovisioned |

### Immutability Convention

Models that represent events (`OrderStatusHistory`, `OrderItem`, `WebhookEvent`, `AuditLog`, `KdsTicket`) intentionally omit `updatedAt`. The absence of `updatedAt` is a signal that these records must not be mutated after creation.

### Soft Delete

Configuration entities that staff manage can be soft-deleted: `Brand`, `Location`, `Menu`, `Printer`, `Integration`. Soft delete uses `deletedAt DateTime?` — null means active.

Transactional records (`Order`, `OrderItem`, `WebhookEvent`, `AuditLog`, `PrintJob`, `KdsTicket`, `OrderStatusHistory`) are never soft-deleted. Audit completeness and regulatory requirements demand that these remain permanently visible.

### Customer Search Projection

`customerPhone` and `customerName` are extracted from the `customerInfo JSON` field at write time and stored as indexed scalar columns. This enables B-tree indexed lookup (`WHERE customerPhone = ?`) without the overhead of GIN indexing on JSON or expression indexes. The JSON blob remains the source of truth for all other customer fields.

### AuditLog Tenant Isolation

`AuditLog.tenantId` is a raw `String`, not a foreign key. This is intentional: audit logs must survive tenant deletion for legal and compliance purposes. The column is indexed but carries no referential constraint.

---

## Entity Reference

### Core Tenancy

| Model | Purpose |
|---|---|
| `Tenant` | Root multi-tenancy unit. Every other entity is scoped to a tenant. |
| `Brand` | Logical restaurant brand under a tenant. One tenant → many brands. Soft-deletable. |
| `Location` | Physical restaurant site under a brand. Printers, integrations, and orders attach here. Soft-deletable. |
| `User` | Staff accounts. Role-based (`PLATFORM_ADMIN` down to `CASHIER`). Scoped to a tenant. |

### Order Pipeline

| Model | Purpose |
|---|---|
| `Order` | Central transactional record. Holds the canonical order state and financial figures. Never deleted. |
| `OrderItem` | Line items. Immutable after creation. Modifiers stored as JSON array. |
| `OrderStatusHistory` | Full audit trail of every status transition with actor, timestamp, and metadata. Immutable. |
| `WebhookEvent` | Raw inbound webhook record, stored before processing for replay and audit. Deduplication key: `(platform, externalEventId)`. |

### Kitchen Display

| Model | Purpose |
|---|---|
| `KdsScreen` | A physical or virtual KDS display at a location. Scoped to a station (e.g., `GRILL`, `ASSEMBLY`). |
| `KdsTicket` | One ticket per order per screen. `bumpedAt` is set when staff bump the ticket. Cascades on screen or order deletion. |

### Printing

| Model | Purpose |
|---|---|
| `Printer` | A printer device at a location. Capabilities declared via `supportsReceipts`, `supportsKitchen`, `supportsLabels`. Soft-deletable. |
| `PrintJob` | One print job per printer per trigger event. Tracks status through `QUEUED → PRINTING → PRINTED` (or `FAILED`). |

### Integrations

| Model | Purpose |
|---|---|
| `Integration` | Credentials and settings for one platform at one location. `@@unique([locationId, platform])`. Soft-deletable. |

### Menus

| Model | Purpose |
|---|---|
| `Menu` | Menu definition attached to a brand. Soft-deletable. |
| `MenuCategory` | Ordered sections within a menu. |
| `MenuItem` | A product with price and allergens. |
| `MenuItemOnCategory` | Junction: item ↔ category with sort order. |

### Observability

| Model | Purpose |
|---|---|
| `AuditLog` | Append-only log of significant mutations. No FK on `tenantId` — survives tenant deletion. |

---

## Index Strategy

### Guiding Principles

1. **Partitioning-ready**: composite indexes lead with `tenantId` or `locationId` so they remain valid when Postgres RANGE partitioning by `createdAt` is applied. Partitioned tables require the partition key to be part of every unique constraint.

2. **Live board**: `[locationId, status, createdAt(sort: Asc)]` on `Order` supports the most common query — fetch all active orders for a location, sorted oldest-first.

3. **Customer search**: `[tenantId, customerPhone]` and `[tenantId, customerName]` enable CRM-style lookup without full-table scans on JSON.

4. **Queue hygiene**: `[printerId, status]` on `PrintJob` and `[locationId, status]` on `Integration` let the worker poll efficiently for QUEUED items.

5. **Audit queries**: `[tenantId, createdAt(sort: Desc)]` on `OrderStatusHistory`, `WebhookEvent`, and `AuditLog` supports time-range audit queries scoped to a tenant.

---

## Data Retention Strategy

| Data class | Retention approach |
|---|---|
| Orders + line items | Permanent. Required for accounting, chargebacks, and regulatory queries. |
| OrderStatusHistory | Permanent. Full audit trail per order. |
| WebhookEvents | Permanent. Required for replay and deduplication. Archive to cold storage after 12 months. |
| AuditLogs | Permanent. Legal requirement. |
| PrintJobs | 90 days hot; archive after. No business need beyond troubleshooting. |
| KdsTickets | 30 days hot; delete after. Operational only. |

---

## Scaling Notes

### Partitioning Readiness

The `Order` table is the primary partition candidate. The strategy is Postgres RANGE partitioning on `createdAt` with monthly or quarterly ranges. The composite indexes already lead with `tenantId`/`locationId`, satisfying Postgres's requirement that the partition key appear in unique constraints.

To apply partitioning when volume demands it:
1. Create a new partitioned `orders_v2` table.
2. Backfill via batched `INSERT INTO ... SELECT`.
3. Rename tables atomically.
4. Add partition maintenance via `pg_partman` or a scheduled cron.

### Analytics Readiness

The `sourceMetadata JSON` field on `Order` and `metadata JSON` fields throughout the schema are intended for future BI extraction. The design intent is to push these fields into a column store (e.g., Redshift, BigQuery, ClickHouse) via CDC (Debezium → Kafka) rather than running analytics queries on the OLTP database.

`orderSource` (sales channel: `UBER_EATS`, `KIOSK`, `TABLE_QR`, etc.) and `integrationSource` (adapter mechanism: `UBER_EATS_WEBHOOK`, `HUBRISE`, etc.) are separate fields specifically to enable accurate attribution reporting.
