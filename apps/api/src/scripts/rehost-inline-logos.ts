/**
 * Move logos already stored as base64 out of Postgres and into storage.
 *
 * New saves are handled at write time (rehostImageIfInline), but logos
 * uploaded before that are still sitting in `brands.logoUrl` and
 * `locations.logoUrl` as `data:image/...;base64,…`. Each one is re-sent inside
 * the JSON on every storefront load — one live shop was carrying 304KB this
 * way, 31% of a 2MB response, for an image the browser could otherwise cache
 * after the first visit.
 *
 *   Dry run (default — prints what it would do, writes nothing):
 *     pnpm --filter @orderhub/api exec tsx src/scripts/rehost-inline-logos.ts
 *
 *   For real:
 *     pnpm --filter @orderhub/api exec tsx src/scripts/rehost-inline-logos.ts --apply
 *
 * Safe to re-run: rows whose logoUrl is already an https URL are skipped, and
 * a row is only updated after its upload succeeds. A failed upload leaves the
 * row exactly as it was.
 */
import { PrismaClient } from "@orderhub/database";
import { SupabaseStorageService } from "../modules/uploads/supabase-storage.service";
import { ConfigService } from "@nestjs/config";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const kb = (s: string) => Math.round(s.length / 1024);

async function main() {
  const storage = new SupabaseStorageService(new ConfigService());
  if (!storage.isConfigured()) {
    console.error(
      "Supabase storage isn't configured — set the storage env vars before running this.",
    );
    process.exit(1);
  }

  console.log(APPLY ? "APPLYING changes\n" : "DRY RUN — nothing will be written\n");

  let moved = 0;
  let bytes = 0;
  let failed = 0;

  for (const table of ["brand", "location"] as const) {
    // `startsWith: "data:"` keeps this to the rows that actually need it
    // rather than pulling every logo in the tenant into memory.
    const rows: Array<{ id: string; name: string; logoUrl: string | null }> =
      await (prisma as any)[table].findMany({
        where: { logoUrl: { startsWith: "data:" } },
        select: { id: true, name: true, logoUrl: true },
      });

    console.log(`${table}s with an inline logo: ${rows.length}`);
    for (const row of rows) {
      const size = kb(row.logoUrl!);
      if (!APPLY) {
        console.log(`  would move ${size}KB — ${table} "${row.name}"`);
        moved++;
        bytes += size;
        continue;
      }
      try {
        const url = await storage.uploadDataUrl(row.logoUrl!, "logos");
        await (prisma as any)[table].update({
          where: { id: row.id },
          data: { logoUrl: url },
        });
        console.log(`  moved ${size}KB — ${table} "${row.name}" → ${url}`);
        moved++;
        bytes += size;
      } catch (err: any) {
        // Left inline, still rendering. Worth a retry, not a rollback.
        console.error(`  FAILED ${table} "${row.name}": ${err?.message ?? err}`);
        failed++;
      }
    }
  }

  console.log(
    `\n${APPLY ? "Moved" : "Would move"} ${moved} logo(s), ~${bytes}KB off every storefront response.` +
      (failed ? ` ${failed} failed and were left inline.` : ""),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
