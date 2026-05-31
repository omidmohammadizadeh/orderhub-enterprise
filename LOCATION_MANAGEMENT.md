# Location Management

`/dashboard/locations` is the operator's home for restaurants in the tenant.

## Card actions

| Chip | Opens | Does |
|---|---|---|
| POS settings | `LocationEditModal` General tab | Edit name, address, phone, about, logo, custom domain, online slug, Stripe Connect + fee config, status |
| Opening hours | `OpeningHoursDrawer` | Toggle days, edit slots, copy day, apply to other locations |
| Brands | `LocationBrandsDrawer` | List/create brands at this location + manage their platform connections |
| Busy mode | `BusyModeDrawer` | Toggle busy state with reason, until-time, affected platforms |

## Status taxonomy

| `status` | Meaning |
|---|---|
| `active` | Normal — accepting orders |
| `suspended` | Admin-paused (e.g. licence issue) — no orders flow |
| `closed` | Permanently / temporarily closed — soft-deleted on the dashboard |

The separate `busyMode` boolean is an operator-driven *short-term* pause (kitchen overwhelmed) — it doesn't change `status`.

## Online ordering URL

Each location can own one slug. `POST /v1/locations/:id/generate-slug` picks the next available slug derived from the location name (collisions append `-2`, `-3`, …). The customer URL is composed at render time from `APP_URL` / `WEB_URL` (env) and the slug — no DB-stored URL, so renaming the env var doesn't require a backfill.

## Permissions

The `@Roles()` guard on the controller restricts CRUD + opening-hours + busy-mode to `MANAGER`, `TENANT_OWNER`, `PLATFORM_ADMIN`. Read endpoints are open to any authenticated user in the tenant. Per-location manager scoping is a Phase AO RBAC item — see KNOWN_LIMITATIONS.
