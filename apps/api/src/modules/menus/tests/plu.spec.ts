import { randomPlu } from "../plu.service";

// Targeted unit tests for the pure helpers in PluService. The
// DB-touching methods (generateUnique, generateMissingForTenant) are
// covered by integration tests under tests/integration/.

describe("randomPlu", () => {
  it("uses the right prefix per kind", () => {
    expect(randomPlu("product")).toMatch(/^PROD-[A-HJ-NP-Z2-9]{6}$/);
    expect(randomPlu("sku")).toMatch(/^SKU-[A-HJ-NP-Z2-9]{6}$/);
    expect(randomPlu("modifierGroup")).toMatch(/^MG-[A-HJ-NP-Z2-9]{6}$/);
    expect(randomPlu("modifier")).toMatch(/^MOD-[A-HJ-NP-Z2-9]{6}$/);
  });

  it("only uses unambiguous characters in the suffix (no I/O/0/1)", () => {
    // Suffix only — the prefixes themselves intentionally contain O (PROD,
    // MOD) for legibility; we just don't want operators confusing 0/O or
    // 1/I/l inside the random suffix when reading PLUs off a printed label.
    for (let i = 0; i < 200; i++) {
      const plu = randomPlu("product");
      const suffix = plu.replace(/^PROD-/, "");
      expect(suffix).not.toMatch(/[IO01]/);
    }
  });

  it("supports custom length", () => {
    expect(randomPlu("product", 10)).toMatch(/^PROD-[A-HJ-NP-Z2-9]{10}$/);
  });

  it("produces different values across calls (probabilistic)", () => {
    const values = new Set<string>();
    for (let i = 0; i < 100; i++) {
      values.add(randomPlu("product"));
    }
    // 100 random PLUs of length 6 with a 32-char alphabet ≈ 10^9 keyspace
    // → P(collision) over 100 draws is ~5×10⁻⁶; 95+ unique is a safe lower bound.
    expect(values.size).toBeGreaterThanOrEqual(95);
  });
});
