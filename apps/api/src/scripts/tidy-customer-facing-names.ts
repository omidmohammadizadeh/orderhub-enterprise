/**
 * Tidy names a CUSTOMER reads.
 *
 * Two things a card machine put on screen in front of a diner (2026-09-25):
 *
 *   "Table TABEL 2"                     — the tables are spelt wrong
 *   "VEGETARIAN (10\", thin base )"     — a modifier name ends in a space
 *
 * Both are data, not code, and both are invisible in the dashboard: a
 * trailing space looks like nothing at all in a text box, so they can't be
 * found by eye. Hence a script.
 *
 * What it does, and only this:
 *   - TABEL → TABLE in table names (case preserved), then trims
 *   - trims leading/trailing whitespace from table, menu item, modifier group
 *     and modifier option names
 *
 * It never renames anything else, never touches ids or refs, and skips a row
 * whose trimmed name would be empty. Safe to re-run — a second pass finds
 * nothing.
 *
 * Dry-run (prints what it WOULD change, writes nothing):
 *   DATABASE_URL=<url> node apps/api/dist/scripts/tidy-customer-facing-names.js
 *
 * Apply:
 *   APPLY=true node apps/api/dist/scripts/tidy-customer-facing-names.js
 *
 * Limit to one shop (tables only — the menu is shared across locations):
 *   LOCATION_ID=cmptil6110001lrxzbsqw2iwn APPLY=true node …
 */

import { PrismaClient } from "@orderhub/database";

const prisma = new PrismaClient();
const APPLY = process.env["APPLY"] === "true";
const LOCATION = process.env["LOCATION_ID"]?.trim() || null;

/** TABEL → TABLE, Tabel → Table, tabel → table. */
export function fixTabel(name: string): string {
  return name.replace(/\bTABEL\b/gi, (m) =>
    m === m.toUpperCase() ? "TABLE" : m[0] === m[0]!.toUpperCase() ? "Table" : "table",
  );
}

const show = (s: string) => `"${s}"`;

async function tidy(
  label: string,
  rows: Array<{ id: string; name: string }>,
  update: (id: string, name: string) => Promise<unknown>,
  transform: (name: string) => string,
) {
  let changed = 0;
  for (const row of rows) {
    const next = transform(row.name);
    // An empty name is worse than an untidy one — leave it for a human.
    if (next === row.name || !next) continue;
    changed++;
    console.log(`  ${label}: ${show(row.name)} → ${show(next)}`);
    if (APPLY) await update(row.id, next);
  }
  return changed;
}

async function main() {
  const db = prisma as any;
  let changed = 0;

  changed += await tidy(
    "table",
    await db.table.findMany({
      where: LOCATION ? { locationId: LOCATION } : {},
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    (id, name) => db.table.update({ where: { id }, data: { name } }),
    (n) => fixTabel(n).trim(),
  );

  // The menu is brand-wide, so LOCATION_ID doesn't narrow these.
  for (const [label, model] of [
    ["menu item", db.menuItem],
    ["modifier group", db.modifierGroup],
    ["modifier option", db.modifierOption],
  ] as const) {
    changed += await tidy(
      label,
      await model.findMany({ select: { id: true, name: true } }),
      (id: string, name: string) => model.update({ where: { id }, data: { name } }),
      (n: string) => n.trim(),
    );
  }

  console.log(
    changed === 0
      ? "\nNothing to tidy.\n"
      : `\n${changed} name(s) ${APPLY ? "fixed" : "would change"}.` +
          (APPLY ? "\n" : " Re-run with APPLY=true to write.\n"),
  );
}

main()
  .catch((err) => {
    console.error(err.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
