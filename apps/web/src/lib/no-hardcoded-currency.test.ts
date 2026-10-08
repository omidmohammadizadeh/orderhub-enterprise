import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// NO HARDCODED CURRENCY ON A DASHBOARD SCREEN.
//
// Currency lives on the Location — a Dubai shop trades in dirhams — and the
// dashboard has `useCurrency()` for exactly this. Three screens printed pounds
// anyway, and all three failed the same way: a module-level formatter hardcoded
// to GBP, sitting in the same file as the hook.
//
//   analytics  — `fmtGBP`, used at 30 call sites; the hook was imported and
//                used only by two panels at the bottom of the page.
//   marketing  — a module-level `function money()` that SHADOWED the hook's
//                `money` for the two table components that called it.
//   customers  — `fmtGBP` again.
//
// A reviewer cannot catch this by reading a diff, because the formatter looks
// right where it is defined and every call site looks right too. So it is
// checked mechanically instead: no dashboard file may build its own money
// string. Whole-file scan, so it fails on reintroduction anywhere, not only in
// the three files that were wrong.
//
// Scope is the dashboard, where amounts belong to a shop. Our own pricing —
// the SMS wallet, billing, subscriptions, contracts — really is billed in
// sterling and is listed below.

const DASHBOARD = join(__dirname, "..", "app", "(dashboard)");

// Screens showing OUR prices to a merchant, not a merchant's takings.
const OUR_OWN_PRICING_IN_GBP = [
  "wallet",
  "billing",
  "subscription",
  "contracts",
];

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (/\.(tsx|ts)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Strip comments and JSX comment blocks — prose may mention £ freely. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\/.*$/gm, "");
}

const files = tsxFiles(DASHBOARD).filter(
  (f) => !OUR_OWN_PRICING_IN_GBP.some((p) => f.includes(`/dashboard/${p}/`)),
);

describe("dashboard money is the location's, never a hardcoded pound", () => {
  it("has files to check (the glob is not silently empty)", () => {
    // Without this, a broken path would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(20);
  });

  it("builds no Intl formatter pinned to a currency", () => {
    const offenders = files.filter((f) =>
      /currency:\s*["'][A-Z]{3}["']/.test(code(readFileSync(f, "utf8"))),
    );

    expect(offenders.map((f) => f.split("/dashboard/")[1])).toEqual([]);
  });

  it("interpolates no amount after a bare currency symbol", () => {
    // `£${v}` and `$${v}` — the other half of the same mistake. Matching a
    // symbol immediately followed by an interpolation; a lone `${}` is just an
    // ordinary template literal and must not trip this.
    const SYMBOL_THEN_VALUE = /(?:[£€¥₹]|\$)\$\{/;
    const offenders = files.filter((f) =>
      SYMBOL_THEN_VALUE.test(code(readFileSync(f, "utf8"))),
    );

    expect(offenders.map((f) => f.split("/dashboard/")[1])).toEqual([]);
  });

  it("still formats money on the screens that were wrong", () => {
    // The inverse check: deleting a formatter and forgetting to replace it
    // would pass the two rules above and show bare numbers.
    for (const screen of ["analytics", "marketing", "customers"]) {
      const src = readFileSync(
        join(DASHBOARD, "dashboard", screen, "page.tsx"),
        "utf8",
      );
      expect(src).toContain("useCurrency");
      expect(src).toMatch(/\bmoney\(/);
    }
  });
});
