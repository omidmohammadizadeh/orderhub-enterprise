import { buildStepState } from "@orderhub/shared";
import { carryGuideOnRename, copyGuideToName } from "../build-guide-carry";
import { BuildGuidesService } from "../build-guides.service";

function makeDb(items: Array<{ id: string; brandId: string; name: string }>) {
  const guides: any[] = [
    { id: "g1", tenantId: "t1", brandId: "b1", nameKey: "chicken burrito", name: "Chicken Burrito", steps: [{ id: "s", text: "Roll" }], packNote: "Foil" },
  ];
  let seq = 1;
  return {
    guides,
    buildGuide: {
      findUnique: async ({ where }: any) =>
        guides.find((g) => g.brandId === where.brandId_nameKey.brandId && g.nameKey === where.brandId_nameKey.nameKey) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `g${++seq}`, ...data };
        guides.push(row);
        return row;
      },
      update: async ({ where, data }: any) => Object.assign(guides.find((g) => g.id === where.id), data),
    },
    menuItem: {
      findMany: async ({ where }: any) => items.filter((i) => i.brandId === where.brandId && i.id !== where.id.not),
    },
  };
}

describe("guides follow renames and duplicates", () => {
  it("moves the guide when no other product keeps the old name", async () => {
    const db = makeDb([{ id: "i1", brandId: "b1", name: "Chicken Burrito" }]);
    const r = await carryGuideOnRename(db as any, { itemId: "i1", brandId: "b1", oldName: "Chicken Burrito", newName: "Pollo Burrito" });
    expect(r).toBe("moved");
    expect(db.guides.map((g) => g.nameKey)).toEqual(["pollo burrito"]);
  });

  it("copies it when a clone elsewhere still uses the old name", async () => {
    const db = makeDb([
      { id: "i1", brandId: "b1", name: "Chicken Burrito" },
      { id: "i2", brandId: "b1", name: "chicken burrito" },
    ]);
    const r = await carryGuideOnRename(db as any, { itemId: "i1", brandId: "b1", oldName: "Chicken Burrito", newName: "Pollo Burrito" });
    expect(r).toBe("copied");
    expect(db.guides.map((g) => g.nameKey).sort()).toEqual(["chicken burrito", "pollo burrito"]);
    expect(db.guides[1]).toMatchObject({ packNote: "Foil", tenantId: "t1" });
  });

  it("never overwrites a guide already saved under the new name, and ignores case-only renames", async () => {
    const db = makeDb([{ id: "i1", brandId: "b1", name: "Chicken Burrito" }]);
    db.guides.push({ id: "gx", tenantId: "t1", brandId: "b1", nameKey: "pollo burrito", name: "Pollo Burrito", steps: [] });
    expect(await carryGuideOnRename(db as any, { itemId: "i1", brandId: "b1", oldName: "Chicken Burrito", newName: "Pollo Burrito" })).toBe("none");
    expect(await carryGuideOnRename(db as any, { itemId: "i1", brandId: "b1", oldName: "Chicken Burrito", newName: "CHICKEN  burrito" })).toBe("none");
    expect(db.guides).toHaveLength(2);
  });

  it("a duplicate gets its own copy of the guide", async () => {
    const db = makeDb([]);
    expect(await copyGuideToName(db as any, { brandId: "b1", fromName: "Chicken Burrito", newName: "Chicken Burrito (copy)" })).toBe(true);
    expect(db.guides.map((g) => g.nameKey)).toContain("chicken burrito copy");
  });

  it("swallows storage errors instead of failing the product save", async () => {
    const r = await carryGuideOnRename({} as any, { itemId: "i1", brandId: "b1", oldName: "A", newName: "B" });
    expect(r).toBe("none");
  });
});

describe("modifier-aware steps", () => {
  it("highlights an extra only when it is ordered", () => {
    const step = { onlyWith: ["Cheese"] };
    expect(buildStepState(step, ["Extra Cheese"])).toEqual({ state: "added", matched: ["Extra Cheese"] });
    expect(buildStepState(step, ["Cheesecake"]).state).toBe("notOrdered");
    expect(buildStepState(step, []).state).toBe("notOrdered");
  });
  it("skips a removable step and a skip beats an add", () => {
    expect(buildStepState({ skipWith: ["No onion"] }, ["No Onion"]).state).toBe("skipped");
    expect(buildStepState({ onlyWith: ["Sauce"], skipWith: ["No sauce"] }, ["No sauce"]).state).toBe("skipped");
    expect(buildStepState({}, ["anything"]).state).toBe("always");
  });
});

describe("saving conditions", () => {
  it("keeps onlyWith / skipWith, deduped, and drops empty lists", async () => {
    const guides: any[] = [];
    const prisma = {
      menuItem: { findUnique: async () => ({ id: "i1", brandId: "b1", name: "Taco" }) },
      brand: { findFirst: async () => ({ id: "b1" }) },
      buildGuide: {
        upsert: async ({ create }: any) => {
          guides.push({ id: "g", ...create, updatedAt: new Date() });
          return guides[0];
        },
      },
    };
    const svc = new BuildGuidesService(prisma as any);
    const g = await svc.saveForItem("i1", "t1", {
      steps: [
        { text: "Add cheese", onlyWith: ["Extra cheese", "Extra cheese", " "] },
        { text: "Add onion", skipWith: ["No onion"], onlyWith: [] },
      ],
    });
    expect(g!.steps[0]).toMatchObject({ onlyWith: ["Extra cheese"] });
    expect(g!.steps[0]).not.toHaveProperty("skipWith");
    expect(g!.steps[1]).toMatchObject({ skipWith: ["No onion"] });
    expect(g!.steps[1]).not.toHaveProperty("onlyWith");
  });
});
