/**
 * CLI for the inline-image rehost. Prefer the dashboard:
 *
 *   Settings → Image storage  (platform admins)
 *
 * which runs this exact code on the server, where the Supabase credentials
 * already live — so nobody has to hold the service_role key in a terminal.
 * This script is for the case where the dashboard isn't reachable.
 *
 * The logic lives in InlineImageRehostService, not here, so the button and
 * the CLI cannot drift apart. A migration with two implementations is one
 * whose dry run does not predict its apply.
 *
 *   Dry run (default — prints what it would do, writes nothing):
 *     npx tsx src/scripts/rehost-inline-images.ts
 *
 *   For real:
 *     npx tsx src/scripts/rehost-inline-images.ts --apply
 *
 *   One model only, or a bigger batch:
 *     npx tsx src/scripts/rehost-inline-images.ts --only=menu --limit=100 --apply
 *
 * Needs DATABASE_URL, DIRECT_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 * Safe to re-run and safe to interrupt: rows already on an https URL are never
 * selected, and a row is only updated after its own upload succeeds.
 */
import { PrismaClient } from "@orderhub/database";
import { ConfigService } from "@nestjs/config";
import { SupabaseStorageService } from "../modules/uploads/supabase-storage.service";
import { InlineImageRehostService } from "../modules/uploads/inline-image-rehost.service";

const prisma = new PrismaClient();
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const APPLY = process.argv.includes("--apply");
const ONLY = arg("only");
const LIMIT = Number(arg("limit") ?? 25);

async function main() {
  const storage = new SupabaseStorageService(new ConfigService());
  // `prisma` stands in for PrismaService — the service only calls model
  // methods, which both expose identically.
  const rehost = new InlineImageRehostService(prisma as any, storage);

  const summary = await rehost.run({
    apply: APPLY,
    only: ONLY,
    limit: LIMIT,
    db: prisma,
  });

  if (!summary.configured) {
    console.error(
      "Supabase storage isn't configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this.",
    );
    process.exit(1);
  }

  console.log(APPLY ? "APPLYING changes\n" : "DRY RUN — nothing will be written\n");
  for (const row of summary.rows) {
    const where = `${row.model}.${row.column}`;
    if (row.error) console.error(`  FAILED ${where} "${row.name}": ${row.error}`);
    else if (row.url) console.log(`  moved ${row.kilobytes}KB — ${where} "${row.name}" → ${row.url}`);
    else console.log(`  would move ${row.kilobytes}KB — ${where} "${row.name}"`);
  }

  const mb = (summary.kilobytes / 1024).toFixed(1);
  console.log(
    `\n${APPLY ? "Moved" : "Would move"} ${summary.moved} image(s), ~${summary.kilobytes}KB (${mb}MB) out of the database.` +
      (summary.failed ? ` ${summary.failed} failed and were left inline.` : ""),
  );
  if (summary.remaining > 0) {
    console.log(
      `At least ${summary.remaining} more are still inline — run again to continue (or pass --limit=100).`,
    );
  }
  if (!APPLY && summary.moved > 0) {
    console.log("Re-run with --apply to actually move them.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
