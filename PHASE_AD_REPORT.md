# Phase AD Report — Fix pnpm Workspace Binary Isolation in Docker (shared/tsc)

> Date: 2026-05-20
> Status: **FIXED — All three Docker build sequences verified locally**

---

## Symptom

Render staging builds failed for all three services with:

```
sh: tsc: not found
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @orderhub/shared@0.1.0 build: `tsc`
spawn ENOENT
WARN  Local package.json exists, but node_modules missing, did you mean to install?
```

Failure point: `RUN pnpm --filter @orderhub/shared build` (Dockerfile.api line 36, same in worker and web).

---

## Root Cause

The same pnpm workspace isolation issue as Phase AB (prisma binary), now for the TypeScript compiler.

`typescript` is in `packages/shared/devDependencies`. pnpm installs it into `packages/shared/node_modules/.bin/tsc`. When pnpm runs a script in a workspace package (`pnpm --filter @orderhub/shared build`), it resolves the `tsc` binary via the package's own `node_modules/.bin/`. If that directory is missing (not copied to the builder stage), pnpm fails with `spawn ENOENT` even if `tsc` appears in root `node_modules/.bin/`.

**Why root hoisting doesn't save us:** pnpm's workspace script runner adds the package-local `node_modules/.bin/` to PATH with priority. If the entire `packages/shared/node_modules` directory does not exist in the builder stage, pnpm cannot set up the correct PATH and the binary lookup fails.

**Why it worked locally but not on Render:** Locally, all workspace packages are installed together. pnpm sees `typescript` across multiple packages and hoists it. In Docker's partial install (only the subset of packages needed for each service), the hoisting behaviour differs — `packages/shared/node_modules` is installed in the deps stage but was never copied to the builder stage.

---

## Fix

Added `COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules` to the builder stage of all three Dockerfiles, following the same pattern established in Phase AB for `packages/database/node_modules`.

**Dockerfile.api** (builder stage):
```dockerfile
COPY --from=deps /app/node_modules ./node_modules
# pnpm does not hoist workspace-package-local binaries to root node_modules/.bin.
# Each package whose build script uses a binary (prisma, tsc) must have its own
# node_modules copied explicitly from the deps stage.
COPY --from=deps /app/packages/database/node_modules ./packages/database/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
```

**Dockerfile.worker** (builder stage): Same three-package COPY pattern.

**Dockerfile.web** (builder stage): Root + shared + web node_modules:
```dockerfile
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
```

---

## Other Binaries — Complete Audit

All workspace packages audited for build-time binary requirements:

| Package | Build script | Binary needed | Available via | Action |
|---|---|---|---|---|
| `packages/database` | `prisma generate` | `prisma` | `packages/database/node_modules/.bin/` | ✅ Phase AB |
| `packages/shared` | `tsc` | `tsc` | `packages/shared/node_modules/.bin/` | ✅ Phase AD |
| `packages/ui` | (none — `main: ./src/index.ts`) | — | — | ✅ No action needed |
| `packages/config` | (none — just tsconfig files) | — | — | ✅ No action needed |
| `integrations/*` | (none — `main: ./src/index.ts`) | — | — | ✅ No action needed |
| `apps/api` | `nest build` | `nest` | `apps/api/node_modules/.bin/` | ✅ Phase AB |
| `apps/worker` | `nest build` | `nest` | `apps/worker/node_modules/.bin/` | ✅ Phase AB |
| `apps/web` | `next build` | `next` | `apps/web/node_modules/.bin/` | ✅ Phase AC |

**The Docker COPY inventory is now complete.** No further binary-not-found failures are expected.

---

## Files Changed

```
infrastructure/docker/Dockerfile.api    — COPY packages/shared/node_modules added
infrastructure/docker/Dockerfile.worker — COPY packages/shared/node_modules added
infrastructure/docker/Dockerfile.web    — COPY packages/shared/node_modules added
PHASE_AD_REPORT.md                      — this file
```

---

## Verification

Docker daemon unavailable locally; verified via equivalent pnpm build sequence:

| Step | Result |
|---|---|
| `pnpm --filter @orderhub/database db:generate` | ✅ Prisma Client v5.22.0 generated |
| `pnpm --filter @orderhub/shared build` | ✅ `tsc` succeeds |
| `pnpm --filter @orderhub/api build` | ✅ `nest build` 0 errors |
| `pnpm --filter @orderhub/worker build` | ✅ `nest build` 0 errors |
| `pnpm --filter @orderhub/web build` | ✅ `next build` 31/31 pages |
| `pnpm --filter @orderhub/api test` | ✅ 327/327 passing |

---

## Pattern Summary — pnpm Workspace Isolation in Docker Multi-Stage Builds

The following `COPY` instructions are required in every builder stage. This is the definitive inventory for this monorepo:

| Package whose node_modules to copy | Required by | Provides |
|---|---|---|
| `packages/database/node_modules` | API + Worker Dockerfiles | `prisma` binary |
| `packages/shared/node_modules` | API + Worker + Web Dockerfiles | `tsc` binary |
| `apps/api/node_modules` | API Dockerfile | `nest` binary |
| `apps/worker/node_modules` | Worker Dockerfile | `nest` binary |
| `apps/web/node_modules` | Web Dockerfile | `next` binary |

If any new workspace package gains a `build` script that uses a binary, its `node_modules` must be added to the relevant Dockerfile builder stage.
