import { readFileSync, readdirSync } from "fs";
import { join } from "path";

// Does the voice module only read columns that exist?
//
// Three live calls have now been broken by a field name that was never on the
// model, and none of them were caught by the compiler, because every query in
// this module goes through a `db()` helper that casts Prisma to `any`:
//
//   orderSource: "PHONE"        — not a member of either enum; every order
//                                 failed to save after the caller confirmed it
//   Customer.name               — the model has firstName/lastName; the query
//                                 threw, a catch swallowed it, and every
//                                 regular was greeted as a stranger
//   Order.estimatedReadyTime    — the column is estimatedReadyAt; asking for
//                                 an order update threw and the caller heard
//                                 silence for the rest of the call
//
// The cast is load-bearing (these models are reached dynamically), so the type
// checker is not coming to help. This reads the real schema instead.

const SCHEMA = join(__dirname, "../../../../../../packages/database/prisma/schema.prisma");
const VOICE_DIR = join(__dirname, "..");

/** Field names declared on one model in schema.prisma. */
function fieldsOf(model: string): Set<string> {
  const schema = readFileSync(SCHEMA, "utf8");
  const start = schema.indexOf(`model ${model} {`);
  if (start === -1) throw new Error(`model ${model} not found in schema.prisma`);
  const end = schema.indexOf("\n}", start);
  const body = schema.slice(start, end);
  const names = new Set<string>();
  for (const line of body.split("\n").slice(1)) {
    const m = /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s+\S/.exec(line);
    if (m?.[1]) names.add(m[1]);
  }
  return names;
}

/** The text from an opening brace to its matching close. */
function balancedFrom(src: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(openIndex, i + 1);
    }
  }
  return src.slice(openIndex);
}

/** Every `<model>.findX({...})` select key used in the voice module. */
function selectedFields(model: string): Array<{ file: string; field: string }> {
  const out: Array<{ file: string; field: string }> = [];
  const files = readdirSync(VOICE_DIR).filter((f) => f.endsWith(".ts"));

  for (const file of files) {
    const src = readFileSync(join(VOICE_DIR, file), "utf8");
    // db().order.findFirst({ ... select: { a: true, b: true } ... })
    const calls = src.matchAll(
      new RegExp(`\\.${model}\\.(?:findFirst|findUnique|findMany)\\(\\{`, "g"),
    );
    for (const call of calls) {
      // Bound the search to THIS call's own braces. A fixed-size window ran
      // past the end of one query into the next one and blamed the wrong
      // model for its fields.
      const chunk = balancedFrom(src, (call.index ?? 0) + call[0].length - 1);
      const sel = /select:\s*\{([^}]*)\}/.exec(chunk);
      if (!sel?.[1]) continue;
      for (const m of sel[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*true/g)) {
        if (m[1]) out.push({ file, field: m[1] });
      }
    }
  }
  return out;
}

describe.each([["order"], ["customer"], ["voiceCall"], ["location"]])(
  "voice module selects only real columns on %s",
  (accessor) => {
    const model = accessor.charAt(0).toUpperCase() + accessor.slice(1);
    it(`every selected field exists on ${model}`, () => {
      const real = fieldsOf(model);
      const used = selectedFields(accessor);
      const bogus = used.filter((u) => !real.has(u.field));
      expect(
        bogus.map((b) => `${b.file}: ${model}.${b.field}`),
      ).toEqual([]);
    });
  },
);

describe("the fields this module depends on", () => {
  it("Order carries the ready time under the name we read", () => {
    // estimatedReadyTime is what we asked for and it does not exist.
    const order = fieldsOf("Order");
    expect(order.has("estimatedReadyAt")).toBe(true);
    expect(order.has("estimatedReadyTime")).toBe(false);
  });

  it("Customer has no `name` column, only firstName/lastName", () => {
    const customer = fieldsOf("Customer");
    expect(customer.has("firstName")).toBe(true);
    expect(customer.has("name")).toBe(false);
  });

  it("VOICE is a real order source and PHONE is not", () => {
    const schema = readFileSync(SCHEMA, "utf8");
    const block = /enum OrderSource \{([^}]*)\}/.exec(schema)?.[1] ?? "";
    expect(block).toContain("VOICE");
    expect(block).not.toContain("PHONE");
  });
});
