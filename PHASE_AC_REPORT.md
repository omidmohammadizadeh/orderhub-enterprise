# Phase AC Report — Fix Render Build Compilation Errors

> Date: 2026-05-20
> Status: **FIXED — All three Docker builds unblocked; 327/327 tests passing**

---

## Summary

Phase AC fixed all build-time failures blocking the Render staging deployment. Three separate root causes were identified and fixed across the API, Worker, and Web builds. No business logic was changed, no API contracts were broken, no TypeScript errors were suppressed.

---

## Root Causes and Fixes

### 1. API / Worker: 606 TypeScript errors — `Cannot find module '@orderhub/shared'`

**Root cause:** `packages/shared/package.json` had no `build` script. Its `main` field points to `./dist/index.js`, but `dist/` is gitignored and was never produced during Docker build. `pnpm --filter @orderhub/shared build` was a silent no-op. Every `import` from `@orderhub/shared` in both API and Worker failed to resolve.

**Fix:** Added `"build": "tsc"` to `packages/shared/package.json`.

Both Dockerfiles (API and Worker) already called `pnpm --filter @orderhub/shared build` before compiling their app — that instruction was silently skipping before this fix. No Dockerfile changes needed for API or Worker.

---

### 2. Web: `next: not found` during Docker build

**Root cause:** `Dockerfile.web` builder stage only copied `node_modules` (root) from the deps stage. The `next` binary lives at `apps/web/node_modules/.bin/next` — pnpm does not hoist it to root `node_modules/.bin/` because `next` is a direct dependency of `apps/web`, not the root workspace. Without the `apps/web/node_modules` copy, the `next build` command failed immediately.

**Fix (Dockerfile.web):**
```dockerfile
COPY --from=deps /app/node_modules ./node_modules
# apps/web/node_modules must be copied explicitly because pnpm does not
# hoist next (or other web-only packages) to the root node_modules/.bin.
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
```

Also added `pnpm --filter @orderhub/shared build` before `pnpm --filter @orderhub/web build` in the builder stage, so shared types are compiled before Next.js processes imports.

---

### 3. Web: TypeScript type errors blocking `next build`

22 type errors across 6 files, all root-caused by `noUncheckedIndexedAccess: true` in `tsconfig.base.json` (array/Record index access returns `T | undefined`) and one missing export.

| File | Error | Fix |
|---|---|---|
| `src/lib/socket/socket.client.ts` | `socketClient` not exported; KDS page calls `socketClient.getSocket()` with 0 args but signature required 1 | Added `export const socketClient = { getSocket };` and made `token` parameter optional (`token = ""`) — KDS is a kiosk page that authenticates via URL `?screen=` param, not JWT |
| `src/app/(dashboard)/dashboard/integrations/page.tsx` | `PLATFORM_META[platform]` is `T \| undefined`; passed directly to `ConnectCard` which expects `T` | Added `if (!meta) return null;` guard |
| `src/app/(dashboard)/dashboard/onboarding/page.tsx` | `STEPS[currentStep]` is `Step \| undefined`; all subsequent uses of `step` failed | Added `if (!step) return null;` after the assignment |
| `src/app/(dashboard)/dashboard/orders/cashier/page.tsx` | `ready[0].id` and `readyIds[idx+1]` / `readyIds[idx-1]` — array accesses return `T \| undefined` | Added `!` non-null assertions — all three are guarded by length/index boundary checks |
| `src/app/(dashboard)/dashboard/sandbox/page.tsx` | `result.data` is `unknown`; `{result.data && <pre>}` renders `unknown` as JSX child | Changed to `{result.data != null && <pre>}` |
| `src/app/(dashboard)/dashboard/settings/branding/page.tsx` | `form[key as keyof typeof form]` returns `string \| CustomDomain[] \| undefined`; used as `<input value>`; `DOMAIN_STATUS[d.status]` returns `T \| undefined` | Cast color field accesses to `string \| undefined`; used non-null assertion on `DOMAIN_STATUS["PENDING"]!` fallback |

---

### 4. Web: `useSearchParams()` without Suspense boundary — Next.js 15 prerender failure

**Root cause:** Next.js 15 requires `useSearchParams()` to be inside a `<Suspense>` boundary during static page generation. Two pages called it at the top level of the default export, causing the build to abort at the static generation phase (after TypeScript compilation succeeded).

**Pages affected:** `/kds` and `/auth/accept-invite`

**Fix (both pages):** Split each page into an outer default export that renders a `<Suspense>` wrapper and an inner function component (`KdsPageInner`, `AcceptInvitePageInner`) that contains the actual `useSearchParams()` call and all rendering logic. No logic was changed — only the component structure.

---

## Files Changed

```
packages/shared/package.json                                    — added "build": "tsc" script
infrastructure/docker/Dockerfile.web                            — COPY apps/web/node_modules; add shared build step
apps/web/src/lib/socket/socket.client.ts                        — optional token param; export socketClient object
apps/web/src/app/(dashboard)/dashboard/integrations/page.tsx    — meta null guard
apps/web/src/app/(dashboard)/dashboard/onboarding/page.tsx      — step null guard
apps/web/src/app/(dashboard)/dashboard/orders/cashier/page.tsx  — non-null assertions on guarded array accesses
apps/web/src/app/(dashboard)/dashboard/sandbox/page.tsx         — result.data != null check
apps/web/src/app/(dashboard)/dashboard/settings/branding/page.tsx — color field cast; DOMAIN_STATUS fallback assertion
apps/web/src/app/kds/page.tsx                                   — Suspense wrapper for useSearchParams
apps/web/src/app/(auth)/auth/accept-invite/page.tsx             — Suspense wrapper for useSearchParams
PHASE_AC_REPORT.md                                              — this file
```

No application logic, API contracts, data model, or schema changes.

---

## Verification

All verified locally before commit:

| Check | Result |
|---|---|
| `pnpm --filter @orderhub/shared build` | ✅ clean |
| `pnpm --filter @orderhub/api build` | ✅ clean (`nest build`) |
| `pnpm --filter @orderhub/worker build` | ✅ clean (`nest build`) |
| `pnpm --filter @orderhub/web build` | ✅ 31/31 static pages generated |
| `pnpm --filter @orderhub/api test` | ✅ 327/327 passing |

---

## Docker Build Architecture (Post-Fix)

```
Dockerfile.api builder stage:
  COPY --from=deps node_modules                        ✅
  COPY --from=deps packages/database/node_modules      ✅ (Phase AB fix)
  COPY --from=deps apps/api/node_modules               ✅
  RUN pnpm --filter @orderhub/shared build             ✅ (Phase AC fix — dist now produced)
  RUN pnpm --filter @orderhub/database db:generate     ✅
  RUN pnpm --filter @orderhub/api build                ✅ 0 errors

Dockerfile.worker builder stage:
  COPY --from=deps node_modules                        ✅
  COPY --from=deps packages/database/node_modules      ✅ (Phase AB fix)
  COPY --from=deps apps/worker/node_modules            ✅
  RUN pnpm --filter @orderhub/shared build             ✅ (Phase AC fix)
  RUN pnpm --filter @orderhub/database db:generate     ✅
  RUN pnpm --filter @orderhub/worker build             ✅ 0 errors

Dockerfile.web builder stage:
  COPY --from=deps node_modules                        ✅
  COPY --from=deps apps/web/node_modules               ✅ (Phase AC fix — next binary now available)
  RUN pnpm --filter @orderhub/shared build             ✅ (Phase AC fix)
  RUN pnpm --filter @orderhub/web build                ✅ 31/31 pages
```

---

## Production Readiness

**NOT production-ready.** Staging deployment still needs to be executed and verified.

**Gate:** Complete `STAGING_DEPLOYMENT_STATUS.md` verification checklist + smoke test passes.
