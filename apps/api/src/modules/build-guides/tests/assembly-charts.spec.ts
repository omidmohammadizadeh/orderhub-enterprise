import { NotFoundException } from "@nestjs/common";
import { AssemblyChartsService } from "../assembly-charts.service";
import { carryGuideOnRename } from "../build-guide-carry";

function makePrisma() {
  const charts: any[] = [];
  const items = [
    { id: "i1", brandId: "b1", name: "The Brunette", imageUrl: "https://x/brunette.jpg" },
    { id: "i-foreign", brandId: "b9", name: "The Brunette", imageUrl: null },
  ];
  let seq = 0;
  const k = (w: any) => w.brandId_nameKey;
  return {
    charts,
    menuItem: {
      findUnique: async ({ where }: any) => items.find((i) => i.id === where.id) ?? null,
      findMany: async ({ where }: any) =>
        items.filter((i) => (where.id?.in ? where.id.in.includes(i.id) : where.brandId.in.includes(i.brandId))),
    },
    brand: { findFirst: async ({ where }: any) => (where.id === "b1" && where.tenantId === "t1" ? { id: "b1" } : null) },
    order: {
      findFirst: async ({ where }: any) =>
        where.tenantId === "t1"
          ? {
              id: "o1",
              brandId: null,
              items: [
                { id: "l1", name: "The Brunette", quantity: 1, modifiers: [], notes: null, menuItemId: null },
                { id: "l2", name: "Fries", quantity: 1, modifiers: [], notes: null, menuItemId: null },
              ],
            }
          : null,
    },
    assemblyChart: {
      findUnique: async ({ where }: any) =>
        charts.find((c) => c.brandId === k(where).brandId && c.nameKey === k(where).nameKey) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const c = charts.find((x) => x.brandId === k(where).brandId && x.nameKey === k(where).nameKey);
        if (c) return Object.assign(c, update, { updatedAt: new Date() });
        const row = { id: `c${++seq}`, ...create, updatedAt: new Date() };
        charts.push(row);
        return row;
      },
      deleteMany: async ({ where }: any) => {
        for (let i = charts.length - 1; i >= 0; i--)
          if (charts[i].brandId === where.brandId && charts[i].nameKey === where.nameKey) charts.splice(i, 1);
        return { count: 1 };
      },
      findMany: async ({ where, select }: any) => {
        const rows = charts.filter(
          (c) => c.tenantId === where.tenantId && (!where.nameKey || where.nameKey.in.includes(c.nameKey)),
        );
        return select ? rows.map((c) => ({ brandId: c.brandId, nameKey: c.nameKey })) : rows;
      },
      create: async ({ data }: any) => (charts.push({ id: `c${++seq}`, ...data }), data),
      update: async ({ where, data }: any) => Object.assign(charts.find((c) => c.id === where.id), data),
    },
  };
}

const LAYERS = [
  { kind: "bun_top", label: "Toasted" },
  { kind: "sauce", label: "Biggy Mac sauce", color: "#F39A2B" },
  { kind: "sauce", label: "Bad colour", color: "orange" },
  { kind: "flying_saucer", label: "Mystery layer" },
  { kind: "custom", label: "" },
  { kind: "patty_cheese", label: "85g smash patty with cheese", callout: "Check for cheese on order" },
  { kind: "bun_bottom", label: "Toasted" },
];

describe("AssemblyChartsService", () => {
  it("saves cleaned layers: unknown kinds become custom, bad colours dropped, empty custom skipped", async () => {
    const prisma = makePrisma();
    const svc = new AssemblyChartsService(prisma as any);
    const c = await svc.saveForItem("i1", "t1", { layers: LAYERS, altTitle: "The Proper Fitty" });
    expect(c!.title).toBe("The Brunette");
    expect(c!.altTitle).toBe("The Proper Fitty");
    expect(c!.layers.map((l) => l.kind)).toEqual(["bun_top", "sauce", "sauce", "custom", "patty_cheese", "bun_bottom"]);
    expect(c!.layers[1]!.color).toBe("#F39A2B");
    expect(c!.layers[2]).not.toHaveProperty("color");
    expect(c!.layers[4]!.callout).toBe("Check for cheese on order");
  });

  it("falls back to the product photo for the hero and removes a chart saved with no layers", async () => {
    const prisma = makePrisma();
    const svc = new AssemblyChartsService(prisma as any);
    await svc.saveForItem("i1", "t1", { layers: LAYERS });
    const res = await svc.forOrder("o1", "t1");
    expect(res.lines[0]!.chart?.heroImageUrl).toBe("https://x/brunette.jpg");
    expect(res.lines[1]!.chart).toBeNull();
    expect(await svc.saveForItem("i1", "t1", { layers: [] })).toBeNull();
    expect(prisma.charts).toHaveLength(0);
  });

  it("refuses another tenant's product and order", async () => {
    const svc = new AssemblyChartsService(makePrisma() as any);
    await expect(svc.getForItem("i-foreign", "t1")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.forOrder("o1", "t2")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a chart follows a product rename like a guide does", async () => {
    const prisma = makePrisma();
    const svc = new AssemblyChartsService(prisma as any);
    await svc.saveForItem("i1", "t1", { layers: LAYERS });
    const r = await carryGuideOnRename(
      { ...prisma, menuItem: { findMany: async () => [] } } as any,
      { itemId: "i1", brandId: "b1", oldName: "The Brunette", newName: "The Proper Fitty" },
      "assemblyChart",
    );
    expect(r).toBe("moved");
    expect(prisma.charts[0].nameKey).toBe("the proper fitty");
    // The printed header follows the new product name.
    expect(prisma.charts[0].title).toBe("The Proper Fitty");
  });
});

describe("assembly chart photo layers", () => {
  it("keeps Order Hub's own proxied photos (/api/v1/…) and drops unsafe links", async () => {
    const prisma: any = {
      menuItem: { findUnique: async () => ({ id: "i1", brandId: "b1", name: "Monster Burger Combo", imageUrl: null }) },
      brand: { findFirst: async () => ({ id: "b1" }) },
      assemblyChart: { upsert: async ({ create }: any) => ({ id: "c1", ...create, updatedAt: new Date() }) },
    };
    const svc = new AssemblyChartsService(prisma);
    const c = await svc.saveForItem("i1", "t1", {
      layers: [
        { kind: "custom", label: "Selected burger", imageUrl: "/api/v1/menus/hubrise-image/q33e7/nej669e" },
        { kind: "custom", label: "Bad", imageUrl: "javascript:alert(1)" },
        { kind: "custom", label: "Protocol-relative", imageUrl: "//evil.example/x.png" },
      ],
    });
    expect(c!.layers[0]!.imageUrl).toBe("/api/v1/menus/hubrise-image/q33e7/nej669e");
    expect(c!.layers[1]).not.toHaveProperty("imageUrl");
    expect(c!.layers[2]).not.toHaveProperty("imageUrl");
  });
});


describe("chart titles across copies and renames", () => {
  it("a copy for a renamed clone takes the new name; a custom title is kept", async () => {
    const charts: any[] = [
      { id: "c1", tenantId: "t1", brandId: "b1", nameKey: "juicy lucy", name: "Juicy Lucy", title: "Juicy Lucy", layers: [] },
      { id: "c2", tenantId: "t1", brandId: "b1", nameKey: "big tower", name: "Big Tower", title: "THE TOWER (special)", layers: [] },
    ];
    let seq = 9;
    const db: any = {
      assemblyChart: {
        findUnique: async ({ where }: any) => charts.find((c) => c.brandId === where.brandId_nameKey.brandId && c.nameKey === where.brandId_nameKey.nameKey) ?? null,
        create: async ({ data }: any) => { const r = { id: `c${++seq}`, ...data }; charts.push(r); return r; },
        update: async ({ where, data }: any) => Object.assign(charts.find((c) => c.id === where.id), data),
      },
      // Another location's clone still uses the old names → copy, not move.
      menuItem: { findMany: async () => [{ name: "Juicy Lucy" }, { name: "Big Tower" }] },
    };
    await carryGuideOnRename(db, { itemId: "i1", brandId: "b1", oldName: "Juicy Lucy", newName: "Juicy Lucy Deluxe" }, "assemblyChart");
    await carryGuideOnRename(db, { itemId: "i2", brandId: "b1", oldName: "Big Tower", newName: "Big Tower XL" }, "assemblyChart");
    expect(charts.find((c) => c.nameKey === "juicy lucy deluxe")?.title).toBe("Juicy Lucy Deluxe");
    expect(charts.find((c) => c.nameKey === "big tower xl")?.title).toBe("THE TOWER (special)");
    // Originals untouched for the location that still sells the old names.
    expect(charts.find((c) => c.id === "c1")?.title).toBe("Juicy Lucy");
  });
});
