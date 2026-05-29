# Phase AK — Known limitations

(To be merged into the canonical KNOWN_LIMITATIONS.md before release.)

## Deferred from Phase AK

- **Multi-SKU JSON editor in the Menu Manager UI** — API endpoints
  accept `productSkus[]` on POST/PATCH item; no in-page grid editor yet.
  Workaround: paste the array via the SwaggerUI or import from a platform.

- **Live OAuth import for Uber Eats / Deliveroo** — classifiers + writer
  + endpoint shapes are wired and tested with paste-JSON; the live
  fetch path needs the Integration row to carry a valid access token
  with the right scopes. Configure them in Phase AL.

- **HubRise import** — not implemented.

- **`availableRestoreAt` cron** — column exists but no worker flips
  `outOfStock` back to false at the scheduled time.

- **POS edit / draft / future order flows** — Base44's `?order_id=`,
  save-as-draft, and schedule-for-later are deferred. POS today only
  produces ACCEPTED orders for immediate processing.

- **POS discount code "Apply" validation** — Base44 shipped this broken
  too. Not regressed; not built either.

- **Auto-schedule activation** — `autoScheduleEnabled` /
  `autoSchedule` columns exist; no worker job acts on them.

- **Drag-and-drop reorder for categories / items** — UI uses numeric
  `sortOrder` fields; reorder is by editing the number.

## Known fragilities (carried from Base44)

- **Deliveroo `item.modifier_ids[]`** — classifier warns when most
  products lack this field. If the warning fires for your account,
  Deliveroo may have rotated the field name; check the raw payload
  in `menu.rawImportPayload`.

- **Uber size variants** — Uber doesn't return separate
  `product_skus`. Pizza-style products with sizes come back as flat
  items. The classifier currently emits one product per Uber item;
  consolidating into `productSkus[]` requires operator hints.

## Schema notes

- `ModifierOption.groupId` (single-group FK) is preserved as the
  "primary group". The new `modifierGroupIds[]` array is the
  authoritative many-to-many membership. New code reads / writes
  both. Older code paths that only know `groupId` keep working.

- `Menu.locationId` is nullable. Existing brand-scoped menus
  (pre-Phase-AK) keep working; new menus created via the Menu Manager
  set `locationId`. The POS `/v1/locations/:id/active-menu` endpoint
  prefers location-scoped and falls back to brand-scoped.

