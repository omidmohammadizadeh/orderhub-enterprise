import { NotFoundException } from "@nestjs/common";
import { buildGuideNameKey, matchBuildGuideKey } from "@orderhub/shared";
import { BuildGuidesService } from "../build-guides.service";

/** Minimal in-memory Prisma covering only what BuildGuidesService touches. */
function makePrisma() {
  const brands = [
    { id: "b-fiesta", tenantId: "t1" },
    { id: "b-placeholder", tenantId: "t1" },
    { id: "b-other", tenantId: "t2" },
  ];
  const items = [
    { id: "i-burrito", brandId: "b-fiesta", name: "Chicken Burrito" },
    // a copy cloned to another location: new id, same brand + name
    { id: "i-burrito-pelton", brandId: "b-fiesta", name: "Chicken  Burrito" },
    { id: "i-foreign", brandId: "b-other", name: "Chicken Burrito" },
  ];
  const guides: any[] = [];
  const orders = [
    {
      id: "o1",
      tenantId: "t1",
      brandId: "b-placeholder",
      items: [
        { id: "l1", name: "Chicken Burrito", quantity: 2, modifiers: [{ name: "Extra cheese" }], notes: null, menuItemId: "i-burrito-pelton" },
        // marketplace line: no product, size in the name
        { id: "l2", name: "Chicken Burrito - Large", quantity: 1, modifiers: null, notes: "no onion", menuItemId: null },
        { id: "l3", name: "Coke", quantity: 1, modifiers: [], notes: null, menuItemId: null },
      ],
    },
  ];
  let seq = 0;
  const key = (w: any) => w.brandId_nameKey;
  return {
    guides,
    brand: { findFirst: async ({ where }: any) => brands.find((b) => b.id === where.id && b.tenantId === where.tenantId) ?? null },
    menuItem: {
      findUnique: async ({ where }: any) => items.find((i) => i.id === where.id) ?? null,
      findMany: async ({ where }: any) => items.filter((i) => where.id.in.includes(i.id)),
    },
    order: {
      findFirst: async ({ where }: any) => orders.find((o) => o.id === where.id && o.tenantId === where.tenantId) ?? null,
    },
    buildGuide: {
      findUnique: async ({ where }: any) =>
        guides.find((g) => g.brandId === key(where).brandId && g.nameKey === key(where).nameKey) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const g = guides.find((x) => x.brandId === key(where).brandId && x.nameKey === key(where).nameKey);
        if (g) return Object.assign(g, update, { updatedAt: new Date() });
        const row = { id: `g${++seq}`, ...create, updatedAt: new Date() };
        guides.push(row);
        return row;
      },
      deleteMany: async ({ where }: any) => {
        for (let i = guides.length - 1; i >= 0; i--) {
          if (guides[i].brandId === where.brandId && guides[i].nameKey === where.nameKey) guides.splice(i, 1);
        }
        return { count: 1 };
      },
      findMany: async ({ where, select }: any) => {
        const rows = guides.filter(
          (g) => g.tenantId === where.tenantId && (!where.nameKey || where.nameKey.in.includes(g.nameKey)),
        );
        return select ? rows.map((g) => ({ brandId: g.brandId, nameKey: g.nameKey })) : rows;
      },
    },
  };
}

describe("buildGuideNameKey / matchBuildGuideKey", () => {
  it("normalises case, spacing, accents and punctuation", () => {
    expect(buildGuideNameKey("  Jalapeño  Poppers & Dip! ")).toBe("jalapeno poppers and dip");
  });
  it("matches exact first, then the longest word-boundary prefix", () => {
    const keys = ["chicken", "chicken wings"];
    expect(matchBuildGuideKey("Chicken Wings (6)", keys)).toBe("chicken wings");
    expect(matchBuildGuideKey("Chicken", keys)).toBe("chicken");
    expect(matchBuildGuideKey("Chickenburger", keys)).toBeNull();
  });
});

describe("BuildGuidesService", () => {
  it("saves a guide for a product and drops empty steps", async () => {
    const prisma = makePrisma();
    const svc = new BuildGuidesService(prisma as any);
    const g = await svc.saveForItem("i-burrito", "t1", {
      steps: [
        { text: "Warm tortilla 10s", amount: "1", tools: ["Press", ""] },
        { text: "   " },
        { text: "Add rice", imageUrl: "javascript:alert(1)" },
      ],
      packNote: "Foil wrap, cut in half",
    });
    expect(g!.steps).toHaveLength(2);
    expect(g!.steps[0]).toMatchObject({ text: "Warm tortilla 10s", amount: "1", tools: ["Press"] });
    expect(g!.steps[1].imageUrl).toBeNull();
    expect(g!.nameKey).toBe("chicken burrito");
  });

  it("shares one guide across cloned copies of the same brand", async () => {
    const prisma = makePrisma();
    const svc = new BuildGuidesService(prisma as any);
    await svc.saveForItem("i-burrito", "t1", { steps: [{ text: "Roll it" }] });
    const fromClone = await svc.getForItem("i-burrito-pelton", "t1");
    expect(fromClone?.steps[0].text).toBe("Roll it");
  });

  it("clearing every step and the pack note removes the guide", async () => {
    const prisma = makePrisma();
    const svc = new BuildGuidesService(prisma as any);
    await svc.saveForItem("i-burrito", "t1", { steps: [{ text: "Roll it" }] });
    expect(await svc.saveForItem("i-burrito", "t1", { steps: [], packNote: "" })).toBeNull();
    expect(prisma.guides).toHaveLength(0);
  });

  it("refuses another tenant's product", async () => {
    const svc = new BuildGuidesService(makePrisma() as any);
    await expect(svc.getForItem("i-foreign", "t1")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.saveForItem("i-foreign", "t1", { steps: [{ text: "x" }] })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("finds guides for order lines by product, by name with a size suffix, and leaves the rest null", async () => {
    const prisma = makePrisma();
    const svc = new BuildGuidesService(prisma as any);
    await svc.saveForItem("i-burrito", "t1", { steps: [{ text: "Roll it" }] });
    const res = await svc.forOrder("o1", "t1");
    expect(res.lines.map((l) => l.guide?.name ?? null)).toEqual(["Chicken Burrito", "Chicken Burrito", null]);
    expect(res.lines[1]).toMatchObject({ quantity: 1, notes: "no onion", modifiers: [] });
  });

  it("does not open another tenant's order", async () => {
    const svc = new BuildGuidesService(makePrisma() as any);
    await expect(svc.forOrder("o1", "t2")).rejects.toBeInstanceOf(NotFoundException);
  });
});
