/**
 * Move images already stored as base64 out of Postgres and into storage.
 *
 * New saves are handled at write time (rehostImageIfInline), but anything
 * uploaded before that — or saved while a Supabase upload was failing, since
 * the dashboard uploader falls back to a data URI — is still sitting in a
 * column as `data:image/...;base64,…`.
 *
 * Two separate costs, and the second is the one that is easy to miss:
 *   • the bytes are re-sent inside the JSON on every storefront load, because
 *     a data URI is part of the response rather than a resource the browser
 *     can cache. Pizza Uno Pelton was carrying a 703KB banner this way — 18%
 *     of a 3.8MB payload, on every single visit.
 *   • no link-preview crawler can use it. WhatsApp, Facebook and the rest
 *     fetch og:image over HTTP by URL, so a shop whose banner lives in a
 *     column has no preview picture unless we serve the bytes ourselves.
 *
 * Supersedes rehost-inline-logos.ts, which covered brand + location logos
 * only. This covers those plus the menu banner/hero/logo, product and
 * modifier images, and the storefront hero.
 *
 *   Dry run (default — prints what it would do, writes nothing):
 *     pnpm --filter @orderhub/api exec tsx src/scripts/rehost-inline-images.ts
 *
 *   For real:
 *     pnpm --filter @orderhub/api exec tsx src/scripts/rehost-inline-images.ts --apply
 *
 *   One table only:
 *     … src/scripts/rehost-inline-images.ts --only=menu --apply
 *
 * Safe to re-run: rows whose column is already an https URL are never
 * selected, and a row is only updated after its upload succeeds. A failed
 * upload leaves the row exactly as it was, still rendering.
 */
import { PrismaClient } from "@orderhub/database";
import { SupabaseStorageService } from "../modules/uploads/supabase-storage.service";
import { ConfigService } from "@nestjs/config";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const ONLY = process.argv
  .find((a) => a.startsWith("--only="))
  ?.slice("--only=".length);

/**
 * Every column that can hold an inline image, and the storage folder its
 * contents belong in. `label` is the column used to name the row in the log —
 * a migration you cannot read is one you cannot verify afterwards.
 */
const TARGETS: Array<{
  model: string;
  columns: string[];
  folder: string;
  label: string;
}> = [
  { model: "brand", columns: ["logoUrl"], folder: "logos", label: "name" },
  { model: "location", columns: ["logoUrl"], folder: "logos", label: "name" },
  {
    model: "menu",
    columns: ["bannerImage", "heroImage", "logoImage"],
    folder: "menus",
    label: "name",
  },
  { model: "menuItem", columns: ["imageUrl"], folder: "products", label: "name" },
  {
    model: "modifierOption",
    columns: ["imageUrl"],
    folder: "modifiers",
    label: "name",
  },
  {
    model: "directOrderingConfig",
    columns: ["heroImageUrl"],
    folder: "storefront",
    label: "id",
  },
];

const kb = (s: string) => Math.round(s.length / 1024);

async function main() {
  const storage = new SupabaseStorageService(new ConfigService());
  if (!storage.isConfigured()) {
    console.error(
      "Supabase storage isn't configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this.",
    );
    process.exit(1);
  }

  console.log(
    APPLY ? "APPLYING changes\n" : "DRY RUN — nothing will be written\n",
  );

  let moved = 0;
  let bytes = 0;
  let failed = 0;

  for (const target of TARGETS) {
    if (ONLY && target.model !== ONLY) continue;

    for (const column of target.columns) {
      // `startsWith: "data:"` keeps this to the rows that actually need it
      // rather than pulling every image in the database into memory.
      const rows: Array<Record<string, any>> = await (prisma as any)[target.model]
        .findMany({
          where: { [column]: { startsWith: "data:" } },
          select: { id: true, [target.label]: true, [column]: true },
        })
        .catch((err: any) => {
          // A column that doesn't exist on this schema version is a reason to
          // skip it, not to abandon the other five.
          console.error(
            `  ! could not read ${target.model}.${column}: ${err?.message ?? err}`,
          );
          return [];
        });

      if (rows.length === 0) continue;
      console.log(`${target.model}.${column} — ${rows.length} inline`);

      for (const row of rows) {
        const value: string = row[column];
        const name = row[target.label] ?? row.id;
        const size = kb(value);

        if (!APPLY) {
          console.log(`  would move ${size}KB — "${name}"`);
          moved++;
          bytes += size;
          continue;
        }
        try {
          const url = await storage.uploadDataUrl(value, target.folder);
          await (prisma as any)[target.model].update({
            where: { id: row.id },
            data: { [column]: url },
          });
          console.log(`  moved ${size}KB — "${name}" → ${url}`);
          moved++;
          bytes += size;
        } catch (err: any) {
          // Left inline, still rendering. Worth a retry, not a rollback.
          console.error(`  FAILED "${name}": ${err?.message ?? err}`);
          failed++;
        }
      }
    }
  }

  const mb = (bytes / 1024).toFixed(1);
  console.log(
    `\n${APPLY ? "Moved" : "Would move"} ${moved} image(s), ~${bytes}KB (${mb}MB) out of the database.` +
      (failed ? ` ${failed} failed and were left inline.` : ""),
  );
  if (!APPLY && moved > 0) {
    console.log("Re-run with --apply to actually move them.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
