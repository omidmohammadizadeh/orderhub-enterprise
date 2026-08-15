import { readFileSync } from "fs";
import { join } from "path";

// ── Every entity syncHash must carry CLASSIFIER_VERSION ─────────────────────
//
// MenuWriterService skips any row whose stored syncHash matches, PER ENTITY.
// So a classifier fix only reaches rows that already exist if the version is
// folded into that row's hash. The menu-level hash isn't enough: it clears the
// short-circuit, the import runs, and then every row is skipped individually.
//
// This is asserted against the source rather than the output because that's
// where it goes wrong. A bulk edit versioned the single-line hashes and
// silently missed the multi-line ones — including the product hash, the one
// that mattered — and the result was a clean-looking import that wrote 138
// groups, 829 options and zero products. Nothing failed. The only signal was
// "products 0/0" in a log line, three deploys later.
//
// A regex over the source is a blunt instrument, but it catches exactly the
// mistake that was made, at zero cost, before it ships.

const CLASSIFIERS = [
  "deliveroo-menu.classifier.ts",
  "uber-menu.classifier.ts",
  "ai-menu.classifier.ts",
];

describe.each(CLASSIFIERS)("%s — sync hash versioning", (file) => {
  const source = (() => {
    try {
      return readFileSync(join(__dirname, "..", "importers", file), "utf8");
    } catch {
      return null;
    }
  })();

  it("hashes every entity through a version-carrying helper", () => {
    if (source === null) return; // classifier doesn't exist / not versioned yet
    if (!source.includes("CLASSIFIER_VERSION")) return;

    // `syncHash: sha(…)` anywhere means that row's hash is version-free, so a
    // classifier fix can never reach a row that already exists.
    const raw = source.match(/syncHash:\s*sha\(/g) ?? [];
    expect(raw).toEqual([]);
  });

  it("puts the version in the helper itself", () => {
    if (source === null || !source.includes("entityHash")) return;
    const helper = source.match(/const entityHash[\s\S]{0,200}/)?.[0] ?? "";
    expect(helper).toContain("CLASSIFIER_VERSION");
  });
});
