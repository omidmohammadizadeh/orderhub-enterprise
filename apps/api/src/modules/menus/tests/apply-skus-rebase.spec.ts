import { BadRequestException } from "@nestjs/common";
import { MenusService } from "../menus.service";

// "Apply to other items" copies a product's sizes onto other products. A size
// is STORED as the total for that size but AUTHORED as a supplement on the
// product's base price, so copying totals verbatim re-prices the target to the
// source's prices — Half Chicken (£8.99) silently became £6.49 when Quarter
// Chicken's (£6.49) sizes were applied to it.
describe("applyItemConfigToItems — sizes carry as supplements", () => {
  const QUARTER = {
    id: "src",
    basePrice: 6.49,
    productSkus: [
      { name: "On its own", plu: "q-1", price: 6.49, modifierGroups: ["g1"] },
      { name: "Make it meal", plu: "q-2", price: 10.48, modifierGroups: ["g1", "g2"] },
    ],
  };

  function build(source: any, targets: any[]) {
    const updates: any[] = [];
    const prisma: any = {
      brand: { findMany: jest.fn(async () => [{ id: "b1" }]) },
      menuItem: {
        findMany: jest.fn(async () => targets),
        update: jest.fn(async (args: any) => {
          updates.push(args);
          return {};
        }),
      },
      modifierGroupOnItem: { createMany: jest.fn(async () => ({ count: 0 })) },
    };
    const svc = new MenusService(prisma, ...([{}, {}, {}, {}, {}, {}] as any));
    (svc as any).assertItemAccess = jest.fn(async () => source);
    (svc as any).assertModifierGroupAccess = jest.fn(async () => ({}));
    return { svc, updates };
  }

  const applied = (updates: any[], i = 0) =>
    updates[i].data.productSkus as any[];

  it("re-anchors each size on the target's own base price", async () => {
    const { svc, updates } = build(QUARTER, [
      { id: "t1", plu: "h", basePrice: 8.99 },
    ]);
    await svc.applyItemConfigToItems("src", "t1x", { targetItemIds: ["t1"], includeSkus: true } as any);
    // Supplements were +0.00 and +3.99; on an £8.99 item that is £8.99/£12.98.
    expect(applied(updates).map((s) => s.price)).toEqual([8.99, 12.98]);
  });

  it("never leaves the target showing a negative supplement", async () => {
    const { svc, updates } = build(QUARTER, [
      { id: "t1", plu: "h", basePrice: 8.99 },
    ]);
    await svc.applyItemConfigToItems("src", "t1x", { targetItemIds: ["t1"], includeSkus: true } as any);
    for (const s of applied(updates)) {
      expect(s.price).toBeGreaterThanOrEqual(8.99);
    }
  });

  it("leaves prices identical when the two items share a base price", async () => {
    const { svc, updates } = build(QUARTER, [
      { id: "t1", plu: "h", basePrice: 6.49 },
    ]);
    await svc.applyItemConfigToItems("src", "t1x", { targetItemIds: ["t1"], includeSkus: true } as any);
    expect(applied(updates).map((s) => s.price)).toEqual([6.49, 10.48]);
  });

  it("copies totals unchanged when the source has no base price", async () => {
    // A sized pizza prices only its sizes — there is no supplement to derive.
    const pizza = {
      id: "src",
      basePrice: 0,
      productSkus: [
        { name: "9 inch", plu: "p-1", price: 8.99, modifierGroups: [] },
        { name: "12 inch", plu: "p-2", price: 11.99, modifierGroups: [] },
      ],
    };
    const { svc, updates } = build(pizza, [{ id: "t1", plu: "h", basePrice: 0 }]);
    await svc.applyItemConfigToItems("src", "t1x", { targetItemIds: ["t1"], includeSkus: true } as any);
    expect(applied(updates).map((s) => s.price)).toEqual([8.99, 11.99]);
  });

  it("still gives every target its own PLUs and keeps the modifier groups", async () => {
    const { svc, updates } = build(QUARTER, [
      { id: "t1", plu: "h", basePrice: 8.99 },
      { id: "t2", plu: "w", basePrice: 8.99 },
    ]);
    await svc.applyItemConfigToItems("src", "t1x", {
      targetItemIds: ["t1", "t2"],
      includeSkus: true,
    } as any);
    expect(applied(updates, 0)[0].plu).not.toBe(applied(updates, 1)[0].plu);
    expect(applied(updates, 0)[1].modifierGroups).toEqual(["g1", "g2"]);
  });

  it("refuses when the source has no sizes at all", async () => {
    const { svc } = build({ id: "src", basePrice: 5, productSkus: [] }, [
      { id: "t1", plu: "h", basePrice: 8.99 },
    ]);
    await expect(
      svc.applyItemConfigToItems("src", "t1x", { targetItemIds: ["t1"], includeSkus: true } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
