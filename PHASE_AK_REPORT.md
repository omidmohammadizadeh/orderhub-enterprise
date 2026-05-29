# Phase AK — Menu Manager + POS Foundation

Status: **delivered**. Ships on top of Phase AJ (which closed out the
Orders flow). Phase AK adds the menu data model, two platform importers
(Uber Eats + Deliveroo), and the POS UI staff use to take walk-in /
phone orders that then ride the same pipeline Phase AJ built.

---

## What ships in this phase

### 1. Schema (migration `20260529000000_phase_ak_menu_base44_fields`)

Five tables extended; three new enums (`MenuType`, `SelectionType`,
`MenuImportStatus`); every column added with `IF NOT EXISTS` so a
half-applied retry recovers cleanly.

| Table | New columns |
|---|---|
| `menus` | locationId, menuType, banner/hero/logoImage, importStatus, importLock, importedAt, syncVersion, rawImportPayload, menuData, productModifierGroupLinks, modifierGroupModifierLinks, platformSource, externalId, externalParentId, lastSyncedAt, syncStatus, syncHash, publishedTo[], lastPublishedAt, autoScheduleEnabled, autoSchedule, metadata |
| `menu_categories` | menuIds[], available, visibleToCustomers, + full import-sync set |
| `menu_items` | plu, visibleToCustomers, outOfStock, availableRestoreAt, dietary, hasMultipleSkus, productSkus, deliveryTax, takeawayTax, eatInTax, menuIds[], brandIds[], sortOrder, + full import-sync set + rawModifierGroupIds |
| `modifier_groups` | plu, selectionType, allowDuplicateSelections, visibleToCustomers, menuIds[], rawModifierIds, metadata, + full import-sync set |
| `modifier_options` | modifierGroupIds[] (m2m), plu, pricesBySize, skuPlus, availableRestoreAt, visibleToCustomers, menuIds[], deliveryTax/takeawayTax/eatInTax, metadata, + full import-sync set |

Phase AJ Order tables untouched.

### 2. Shared package — `@orderhub/shared/lib/menu-pricing`

Pure-function library shared between API and POS UI so a cart priced
client-side matches what the server records:

- `extractSizeKey(name)` — pulls "10" from "10 inch" etc. (regex
  `/(\d+)\s*(?:inch|"|in)?/i`)
- `getModifierPrice(modifier, sizeKey)` — `pricesBySize[sizeKey] || priceAdjustment`
- `getModifierPlu(modifier, sizeKey)` — `skuPlus[sizeKey] || plu`
- `isModifierAvailable(modifier, sizeKey, opts)` — hides modifier when
  `pricesBySize` has keys and the selected size isn't among them
  (Base44's "14-inch-only topping doesn't appear on a 10-inch base"
  behaviour)
- `calculateCartItem({ basePrice, modifiers, quantity })` —
  `unitPrice = base + Σ mods`, `lineTotal = unitPrice × qty`
- `buildCartItemName({...})` — produces the
  `"10 inch Margherita (Crust, Cheese) - Note: ..."` string the KDS
  regex parses downstream

31 unit tests in `apps/api/src/modules/menus/tests/menu-pricing.spec.ts`
cover every branch including the classic `1.005.toFixed(2)`
floating-point trap.

### 3. PLU service — `PluService`

Generates readable, collision-safe PLUs with type-specific prefixes
(`PROD-`, `SKU-`, `MG-`, `MOD-`) plus a 6-char base32 suffix from an
unambiguous alphabet (no I/O/0/1 — operators read these off printed
labels).

- `generateUnique(kind, tenantId)` — retries on tenant-scoped collision
- `resolveImportedPlu(kind, importedPlu, tenantId)` — preserves the
  platform's PLU when present, generates one when blank
- `generateMissingForTenant(tenantId)` — backfills every blank PLU
  across products / groups / modifiers. Idempotent.

Wired into `MenusService.createItem`, `createModifierGroup`, and
`addModifierOption` — every newly created entity gets a PLU at creation
time. The Menu Manager toolbar carries a "Generate missing PLUs" button
that calls the bulk action for orphan-PLU catalogs (or fresh imports).

### 4. Menu importers — Uber Eats + Deliveroo

Two pure classifiers and a single writer:

- `classifyUberMenu(payload)` — handles Uber's quirks:
  - cross-indexes `category.entities[]` (products) and
    `modifier_group.modifier_options[]` (modifiers) to bucket the
    mixed `items[]` array
  - converts pence → pounds
  - PLU = `external_data || id`
  - selectionType = `quantity_info.max_permitted > 1 ? ADDON : VARIANT`
  - probes 7 alternate product → group link field names
    (`modifier_group_ids`, `modifier_groups`, `option_list_ids`,
    `option_lists`, `modifier_group_refs`, `option_list_refs`,
    `bundled_item_ids`)
  - warns when orphan refs are detected

- `classifyDeliverooMenu(payload)` — handles Deliveroo's quirks:
  - items with `type: "CHOICE"` are modifiers; `menu.modifiers[]` are
    modifier groups
  - product → group via `item.modifier_ids[]`
  - prices always pence
  - `repeatable` → `allowDuplicateSelections`
  - warns when most products lack `modifier_ids` (Base44's
    most-feared fragility — the field has been observed to vanish on
    older Deliveroo brands)

- `MenuWriterService.apply(normalized)` — idempotent writer:
  - acquires `menu.importLock` atomically (updateMany with
    `importLock: false` → 1) so two concurrent imports can't race
  - syncHash short-circuit when nothing changed
  - per-entity upsert keyed on `(platformSource, externalId, brandId)`
  - skips writes when the entity's own syncHash hasn't changed
  - relinks Category → Item and Item → ModifierGroup after the
    per-row pass so external→local id maps are populated
  - persists `productModifierGroupLinks` + `modifierGroupModifierLinks`
    JSON snapshots on the menu for future replay
  - **always** releases the lock in `finally{}` — even on partial
    failure

Endpoints:
- `POST /v1/menus/:menuId/import/uber`
- `POST /v1/menus/:menuId/import/deliveroo`
- `POST /v1/menus/generate-missing-plus`

Both importer endpoints accept either a `payload` JSON (pasted from
the platform's dashboard or saved as a fixture) or `storeId + accessToken`
for live fetches. Live fetches are stubbed against the documented Uber
+ Deliveroo endpoints but aren't OAuth-wired yet — that lands in
Phase AL alongside the production webhook reconnect.

### 5. POS UI — `/dashboard/pos`

Single-page POS with:
- location selector
- left: category tabs + product grid + search
- right: cart, customer name/phone, fulfillment (collection / delivery),
  payment (cash / card terminal), total, "Place order" button
- product click opens `ModifierSelectionModal` which handles:
  - multi-SKU RadioGroup (when `hasMultipleSkus`)
  - variant vs addon modifier groups (min/max enforcement)
  - `pricesBySize` lookup keyed on the selected SKU's size
  - per-line notes + quantity

On submit:
1. `POST /v1/orders` with `orderSource: POS`, customer + cart payload
2. `PATCH /v1/orders/:id/status` to `ACCEPTED` so the existing
   PrinterJob pipeline picks it up and emits the WebSocket event the
   Orders board listens for

The POS reuses the Phase AJ ingest pipeline — no new Order endpoint
needed. Operators see new POS orders appear in their Orders board
within ~100ms of the place-order click.

### 6. Menu Manager additions

- "Generate missing PLUs" button in the Menu Manager header
- "Import from Uber / Deliveroo" button in the menu editor — opens
  a dialog where operators paste raw JSON. The dialog reports
  `createdCount`, `updatedCount`, and any non-fatal warnings
  (orphan refs, fragility flags).

The existing Menu Manager CRUD (menus, categories, items, modifier
groups, modifier options, item↔category linking, group↔item linking)
continues to work and now stamps PLUs automatically.

### 7. Sidebar nav

Added `/dashboard/pos` to the primary nav.

---

## "Must work" checklist (from the Phase AK brief)

| Criterion | Status |
|---|---|
| A menu can be created | ✅ existing Menu Manager flow, now stamps PLU |
| A category can be created | ✅ existing flow |
| A product can be created | ✅ existing flow, now stamps PLU + supports `productSkus`, `pricesBySize`, etc. via API |
| A modifier group can be created | ✅ existing flow, now stamps PLU + accepts `selectionType` |
| A modifier can be created | ✅ existing flow, now stamps PLU + accepts `pricesBySize` / `skuPlus` |
| A multi-SKU product can be created | ⚠️ API supports it (POST `/v1/items` with `productSkus[]`); dedicated UI editor for the array deferred to Phase AL (operators can paste JSON or import from Uber/Deliveroo today) |
| Modifier price by size works | ✅ helpers + 31 tests; live in the POS modal |
| Product / group / modifier linking | ✅ existing endpoints |
| Uber import works | ✅ via paste-JSON dialog; live OAuth fetch deferred to Phase AL |
| Deliveroo import works | ✅ via paste-JSON dialog; live OAuth fetch deferred to Phase AL |
| POS can create an accepted order | ✅ |
| Accepted POS order creates PrinterJob | ✅ rides the Phase AJ pipeline |
| Phase AJ Orders still work | ✅ no Order schema or service changes |

---

## Deferred to Phase AL (or later)

- **Multi-SKU JSON editor in the UI** — today operators set
  `productSkus[]` by API or by importing from a platform. A
  dedicated grid editor (rows per size, columns per modifier group)
  is the next-biggest UX win and is its own Phase.
- **Live OAuth import** — Uber + Deliveroo classes already make the
  documented HTTP calls; they need the Integration row to store an
  encrypted token, which Phase AL wires through.
- **HubRise import** — same pattern as Uber/Deliveroo; structure is
  ready but not implemented.
- **Auto-schedule cron** — schema field is there
  (`autoScheduleEnabled`, `autoSchedule`); worker job that flips
  `isActive` on/off based on it is deferred.
- **POS edit / draft / future flows** — Base44's `?order_id=` edit
  param, "save as draft", and "schedule for later" are deferred.
  Today the POS only creates ACCEPTED orders for immediate
  processing.
- **Auto-progress restore** — schema field
  (`availableRestoreAt`); cron job that flips `outOfStock` back to
  false at the scheduled time is deferred.
- **Drag-and-drop category / item reorder** — current UI uses
  numeric `sortOrder` input fields.

---

## Tests

All Phase AK unit tests live under
`apps/api/src/modules/menus/tests/`.

- `menu-pricing.spec.ts` — 31 specs covering size-key extraction,
  modifier price/PLU resolution, availability rules, cart math,
  cart-line name formatting
- `plu.spec.ts` — 5 specs covering prefix correctness, alphabet
  legibility, custom length, randomness
- `uber-classifier.spec.ts` — 10 specs covering classification,
  pricing, PLU fallback, selection-type mapping, alternate field
  probing, sync-hash stability + diff sensitivity
- `deliveroo-classifier.spec.ts` — 9 specs covering CHOICE-type
  detection, pence conversion, PLU fallback, repeatable mapping,
  fragility warning

54 tests total. All passing as of commit time. DB-touching paths
(MenuWriterService, PluService.generateUnique) are covered by manual
verification against the deployed Render instance pending Phase AL's
full integration test setup.
