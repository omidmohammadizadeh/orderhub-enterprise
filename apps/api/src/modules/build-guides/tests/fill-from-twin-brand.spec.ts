import { buildGuideNameKey } from "@orderhub/shared";
import { fillGuidesFromTwinBrand } from "../build-guide-carry";

const chart = (brandId: string, name: string, extra: Record<string, unknown> = {}) => ({
  id: `${brandId}:${name}`,
  tenantId: "t1",
  brandId,
  name,
  nameKey: buildGuideNameKey(name),
  title: name,
  layers: [{ id: brandId }],
  ...extra,
});

function makeDb(rows: any[]) {
  return {
    rows,
    assemblyChart: {
      findMany: async ({ where }: any) =>
        rows.filter((r) => r.tenantId === where.tenantId && where.nameKey.in.includes(r.nameKey)),
      createMany: async ({ data }: any) => {
        rows.push(...data);
        return { count: data.length };
      },
    },
  };
}

describe("fillGuidesFromTwinBrand", () => {
  it("fills a clone whose own brand never had charts from the brand that charts the menu", async () => {
    // FIESTA MEXA sells as PAPI TACO; its charts live under FIESTA-UHS.
    const db = makeDb([
      chart("fiesta-uhs", "Chicken Burrito"),
      chart("fiesta-uhs", "Beef Tacos"),
      chart("fiesta-uhs", "Nachos"),
      chart("kfc", "Coca Cola"), // one shared name only — never a source
      chart("other-tenant", "Chicken Burrito", { tenantId: "t2" }),
    ]);
    const n = await fillGuidesFromTwinBrand(
      db,
      {
        tenantId: "t1",
        items: ["Chicken Burrito", "Beef Tacos", "Nachos", "Coca Cola", "Churros"].map((name) => ({
          brandId: "haddon",
          name,
        })),
      },
      "assemblyChart",
    );
    expect(n).toBe(3);
    const mine = db.rows.filter((r) => r.brandId === "haddon");
    expect(mine.map((r) => r.nameKey).sort()).toEqual(["beef tacos", "chicken burrito", "nachos"]);
    expect(mine.every((r) => r.layers[0].id === "fiesta-uhs" && r.tenantId === "t1")).toBe(true);
  });

  it("never overwrites a chart the brand already has", async () => {
    const db = makeDb([
      chart("haddon", "Nachos", { title: "OURS" }),
      chart("twin", "Nachos"),
      chart("twin", "Beef Tacos"),
    ]);
    const n = await fillGuidesFromTwinBrand(
      db,
      { tenantId: "t1", items: [{ brandId: "haddon", name: "Nachos" }, { brandId: "haddon", name: "Beef Tacos" }] },
      "assemblyChart",
    );
    expect(n).toBe(1);
    expect(db.rows.filter((r) => r.brandId === "haddon" && r.nameKey === "nachos")).toHaveLength(1);
    expect(db.rows.find((r) => r.brandId === "haddon" && r.nameKey === "nachos")?.title).toBe("OURS");
  });
});
