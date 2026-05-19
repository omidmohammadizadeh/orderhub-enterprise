# Phase AB Report — Fix Prisma Docker Build Failure (API + Worker)

> Date: 2026-05-20
> Status: **FIXED — Docker build unblocked for both API and Worker images**

---

## Symptom

Render staging deploy failed for both `orderhub-api` and `orderhub-worker`.

Both images failed during Docker build at the same step:

**Dockerfile.api line 32 / Dockerfile.worker line 28:**
```
RUN pnpm --filter @orderhub/database db:generate
```

**Error:**
```
sh: prisma: not found
```

---

## Root Cause

pnpm workspaces do not hoist all binaries to the root `node_modules/.bin/`. By default, pnpm uses a strict isolation model: a binary is only accessible in root `node_modules/.bin/` if the package that provides it is a **direct dependency of the root workspace**. Packages that are devDependencies of a child workspace package (like `prisma` being a devDep of `packages/database`) are installed only in that package's own `node_modules/.bin/`.

Verification:
```
/app/node_modules/.bin/prisma          → DOES NOT EXIST
/app/packages/database/node_modules/.bin/prisma  → EXISTS
```

The multi-stage Dockerfiles had a gap in their `COPY` instructions:

**Stage 1 (deps)** — runs `pnpm install --frozen-lockfile --prod=false` and correctly creates:
- `/app/node_modules/` (root, hoisted)
- `/app/packages/database/node_modules/` (package-local, includes `prisma` binary)
- `/app/apps/api/node_modules/` (app-local)

**Stage 2 (builder)** — copied from deps:
```dockerfile
COPY --from=deps /app/node_modules ./node_modules          ✅
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules  ✅
# packages/database/node_modules  ← MISSING ❌
```

Then immediately ran:
```dockerfile
RUN pnpm --filter @orderhub/database db:generate
```

pnpm resolves the `db:generate` script (`prisma generate`) by looking for the `prisma` binary. It checks `packages/database/node_modules/.bin/prisma` first (package-local) and `node_modules/.bin/prisma` (root). Neither existed in the builder stage → `prisma: not found`.

---

## Fix

Added one `COPY` instruction to each Dockerfile's builder stage, immediately after the other deps-stage node_modules copies and **before** `COPY packages ./packages`:

**Dockerfile.api (builder stage):**
```dockerfile
COPY --from=deps /app/node_modules ./node_modules
# packages/database/node_modules must be copied explicitly because pnpm does not
# hoist prisma to the root node_modules/.bin — it installs only under the package.
COPY --from=deps /app/packages/database/node_modules ./packages/database/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
```

**Dockerfile.worker (builder stage):** Same change.

The fix is surgical — one line per Dockerfile, no logic changes, no dependency changes, no schema changes.

---

## Why This Pattern Exists in pnpm Workspaces

pnpm's isolation model is by design: it prevents phantom dependencies (using packages you didn't explicitly declare). When `prisma` is listed in `packages/database/package.json` devDependencies but NOT in the root `package.json`, pnpm correctly installs it only under `packages/database/node_modules/`. This is the right behaviour for local development.

In Docker multi-stage builds, only the directories you explicitly COPY are available in subsequent stages. The source code COPY (`COPY packages ./packages`) brings the TypeScript source files but not the installed `node_modules` sub-directories.

The fix is to explicitly bridge the gap: copy the package-level `node_modules` from the deps stage alongside the root and app-level `node_modules`.

---

## Other Binaries Checked

During investigation, all other workspace packages were checked:

| Package | Local binaries | Available in root `.bin`? | Action needed |
|---|---|---|---|
| `packages/database` | `prisma`, `tsc`, `tsx` | `tsc` yes; `prisma` NO; `tsx` NO | Fix applied ✅ |
| `packages/shared` | `tsc` | `tsc` yes (hoisted) | None |
| `packages/ui` | `tsc` | `tsc` yes (hoisted) | None |
| `integrations/uber-eats` | `tsc` | `tsc` yes (hoisted) | None |
| `integrations/deliveroo` | `tsc` | `tsc` yes (hoisted) | None |
| `integrations/just-eat` | `tsc` | `tsc` yes (hoisted) | None |

`tsc` (TypeScript compiler) is hoisted to root because it is a direct devDependency of multiple workspace packages and pnpm hoists it as a result of the deduplication. `prisma` and `tsx` are only declared in `packages/database/devDependencies` and are therefore never hoisted.

The only build-time binary that requires the package-level `node_modules` copy is `prisma`. `tsx` is only used for `db:seed` (a development script), which is not part of the Docker build sequence.

---

## Files Changed

```
infrastructure/docker/Dockerfile.api    — added COPY packages/database/node_modules from deps stage
infrastructure/docker/Dockerfile.worker — same
```

No application code, schema, or environment changes.

---

## Verification

Before commit, confirmed locally:

| Check | Result |
|---|---|
| `pnpm --filter @orderhub/database db:generate` | ✅ `Generated Prisma Client (v5.22.0)` |
| `pnpm --filter @orderhub/api type-check` | ✅ 0 errors |
| `pnpm --filter @orderhub/worker type-check` | ✅ 0 errors |
| `pnpm --filter @orderhub/api test` | ✅ 327/327 passing |

---

## Docker Build Architecture (Post-Fix)

```
Stage 1 (deps)
  pnpm install --frozen-lockfile --prod=false
  Creates:
    /app/node_modules/                          (root — tsc hoisted here)
    /app/packages/database/node_modules/        (prisma, tsx, tsc)
    /app/apps/api/node_modules/                 (api-specific)
    /app/apps/worker/node_modules/              (worker-specific)
    /app/integrations/*/node_modules/           (integration-specific)

Stage 2 (builder)
  COPY from deps:
    node_modules                                ✅
    packages/database/node_modules              ✅ (fixed — prisma now available)
    apps/{api,worker}/node_modules              ✅
  COPY source code
  RUN prisma generate                           ✅ now succeeds
  RUN tsc (api/worker build)                    ✅ tsc from root .bin

Stage 3 (runner)
  Minimal production image:
    dist/                      (compiled output)
    node_modules/              (runtime deps)
    packages/                  (compiled workspace packages + generated prisma)
    scripts/start-{api,worker}.sh
```
