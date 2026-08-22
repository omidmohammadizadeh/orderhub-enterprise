import { MenuTranslationService } from "../menu-translation.service";

// The service fills secondLanguageName across a menu. What matters:
// it batches, it dedupes identical names, it never writes a translation for a
// name it did not ask about, and a blank answer leaves the row alone so the
// ticket keeps printing the original.
function build(opts: {
  items?: any[];
  groups?: any[];
  options?: any[];
  reply?: (names: string[]) => Array<{ source: string; translated: string }>;
}) {
  const calls: string[][] = [];
  const updates: Array<{ table: string; ids: string[]; value: string }> = [];
  const wheres: Record<string, any[]> = {};
  const mk = (table: string, rows: any[]) => ({
    findMany: async (args: any) => {
      (wheres[table] ??= []).push(args?.where);
      return rows;
    },
    updateMany: async ({ where, data }: any) => {
      updates.push({ table, ids: where.id.in, value: data.secondLanguageName });
      return { count: where.id.in.length };
    },
  });
  const prisma: any = {
    menu: { findFirst: async () => ({ id: "m1", brandId: "b1" }) },
    menuItem: mk("menuItem", opts.items ?? []),
    modifierGroup: mk("modifierGroup", opts.groups ?? []),
    modifierOption: mk("modifierOption", opts.options ?? []),
  };
  const svc = new MenuTranslationService(
    { get: (k: string) => (k === "ANTHROPIC_API_KEY" ? "test-key" : undefined) } as any,
    prisma,
  );
  // Stand in for the model.
  (svc as any).translateBatch = async (names: string[]) => {
    calls.push(names);
    const rows = opts.reply
      ? opts.reply(names)
      : names.map((n) => ({ source: n, translated: `ZH:${n}` }));
    const m = new Map<string, string>();
    for (const r of rows) if (r.translated) m.set(r.source, r.translated);
    return m;
  };
  return { svc, calls, updates, wheres };
}

const row = (id: string, name: string, existing: string | null = null) => ({
  id, name, secondLanguageName: existing,
});

const run = (svc: any, overwrite = false) =>
  (svc as any).run("job", { menuId: "m1", tenantId: "t1", language: "Chinese", overwrite });

describe("MenuTranslationService", () => {
  it("translates items, modifier groups AND options", async () => {
    const { svc, updates } = build({
      items: [row("i1", "Egg Fried Rice")],
      groups: [row("g1", "Choose Sauce")],
      options: [row("o1", "Curry Sauce")],
    });
    const res = await run(svc);
    expect(res).toMatchObject({ items: 1, groups: 1, options: 1 });
    expect(updates.map((u) => u.table).sort()).toEqual([
      "menuItem", "modifierGroup", "modifierOption",
    ]);
  });

  it("asks about each distinct NAME once, however many rows share it", async () => {
    // "Chips" repeats across dozens of option groups on a real menu. Options
    // hang off groups which hang off items, so the whole chain must be there.
    const { svc, calls } = build({
      items: [row("i1", "Kebab")],
      groups: [row("g1", "Add a side")],
      options: Array.from({ length: 50 }, (_, i) => row(`o${i}`, "Chips")),
    });
    await run(svc);
    // Asked about ONCE despite 50 rows carrying it.
    expect(calls.flat().filter((n) => n === "Chips")).toEqual(["Chips"]);
  });

  it("updates every row sharing a name in one write", async () => {
    const { svc, updates } = build({
      items: [row("i1", "Kebab")],
      groups: [row("g1", "Add a side")],
      options: Array.from({ length: 50 }, (_, i) => row(`o${i}`, "Chips")),
    });
    await run(svc);
    const optionWrites = updates.filter((u) => u.table === "modifierOption");
    expect(optionWrites).toHaveLength(1);
    expect(optionWrites[0]!.ids).toHaveLength(50);
  });

  it("splits a large menu into batches rather than one huge call", async () => {
    const { svc, calls } = build({
      items: Array.from({ length: 300 }, (_, i) => row(`i${i}`, `Dish ${i}`)),
    });
    await run(svc);
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c.length).toBeLessThanOrEqual(120);
    // Every name still reached the model exactly once.
    expect(new Set(calls.flat()).size).toBe(300);
  });

  it("skips rows that already have a translation", async () => {
    const { svc, calls, updates } = build({
      items: [row("i1", "Egg Fried Rice", "蛋炒饭"), row("i2", "Chow Mein")],
    });
    await run(svc);
    expect(calls.flat()).toEqual(["Chow Mein"]);
    expect(updates.flatMap((u) => u.ids)).toEqual(["i2"]);
  });

  it("re-translates everything when overwrite is set", async () => {
    const { svc, calls } = build({
      items: [row("i1", "Egg Fried Rice", "蛋炒饭")],
    });
    await run(svc, true);
    expect(calls.flat()).toEqual(["Egg Fried Rice"]);
  });

  it("leaves a row alone when the model returns a blank", async () => {
    // A blank means "I am not sure" — the ticket keeps printing the original
    // rather than a guess going to the kitchen.
    const { svc, updates } = build({
      items: [row("i1", "House Special")],
      reply: (n) => n.map((s) => ({ source: s, translated: "" })),
    });
    const res = await run(svc);
    expect(updates).toHaveLength(0);
    expect(res.skipped).toBe(1);
  });

  it("ignores a translation for a name it never asked about", async () => {
    const { svc, updates } = build({
      items: [row("i1", "Chow Mein")],
      reply: () => [{ source: "Something Else", translated: "别的" }],
    });
    await run(svc);
    expect(updates).toHaveLength(0);
  });

  it("does not write a translation identical to the original", async () => {
    const { svc, updates, } = build({
      items: [row("i1", "Pepsi")],
      reply: (n) => n.map((s) => ({ source: s, translated: s })),
    });
    const res = await run(svc);
    expect(updates).toHaveLength(0);
    expect(res.skipped).toBe(1);
  });

  it("refuses a menu belonging to another tenant", async () => {
    const { svc } = build({});
    (svc as any).prisma = undefined;
    const prisma: any = { menu: { findFirst: async () => null } };
    (svc as any).prisma = prisma;
    await expect(run(svc)).rejects.toThrow(/not found/i);
  });

  it("finds items through the menu's CATEGORIES, not just menuIds", async () => {
    // A menu owns its items via Menu -> MenuCategory -> MenuItemOnCategory.
    // MenuItem.menuIds is a parallel array only the importers populate, so
    // querying it alone reported "nothing to translate" on a full menu.
    const { svc, wheres } = build({ items: [row("i1", "Chow Mein")] });
    await run(svc);
    const where = wheres["menuItem"]![0];
    const branches = JSON.stringify(where.OR);
    expect(branches).toContain("categories");
    expect(branches).toContain("menuIds");
  });

  it("asks for only the three fields it needs, never whole rows", async () => {
    // This runs inside the API process, which sits near its heap ceiling —
    // pulling prices, images and JSON blobs to translate a name is how a
    // background job takes the API down with it.
    const { svc } = build({ items: [row("i1", "Chow Mein")] });
    const seen: any[] = [];
    const orig = (svc as any).prisma.menuItem.findMany;
    (svc as any).prisma.menuItem.findMany = async (a: any) => {
      seen.push(a?.select);
      return orig(a);
    };
    await run(svc);
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual([
      "id", "name", "secondLanguageName",
    ]);
  });
});
