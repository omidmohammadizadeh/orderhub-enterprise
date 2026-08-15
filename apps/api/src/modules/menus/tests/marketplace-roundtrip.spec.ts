import { DeliverooMenuPublishService } from "../../integrations/deliveroo/deliveroo-menu-publish.service";
import { UberEatsMenuPublishService } from "../../integrations/ubereats/ubereats-menu-publish.service";
import { buildDeliverooMenu } from "../../integrations/deliveroo/deliveroo-menu.transformer";
import { buildUberEatsMenu } from "../../integrations/ubereats/ubereats-menu.transformer";
import { classifyDeliverooMenu } from "../importers/deliveroo-menu.classifier";
import { classifyUberMenu } from "../importers/uber-menu.classifier";

// ── Publish a sized pizza, then import it back ──────────────────────────────
//
// The two halves are written against the marketplaces, not against each
// other, so nothing stops them drifting apart — and when they drift the
// damage is quiet. Sizes come back at the DIFFERENCE between them (a £10.00
// 12 inch arriving as £2.00), or one authored group comes back as one group
// per size, and each republish re-splits what the operator just merged.
//
// So these drive the real publisher and the real classifier end to end. The
// menu is the one from the Grill Stop pizzas: three sizes, and a crust that
// costs more the bigger the pizza — the case that forces the nesting in the
// first place, because no marketplace can price a modifier according to
// another modifier's selection.

const SKUS = [
  { name: '10 inch', plu: "M10", price: 8, modifierGroups: ["g-base"] },
  { name: '12 inch', plu: "M12", price: 10, modifierGroups: ["g-base"] },
  { name: '14 inch', plu: "M14", price: 12, modifierGroups: ["g-base"] },
];

const BASE_GROUP = {
  id: "g-base",
  name: "Base",
  selectionType: "VARIANT",
  minSelections: 1,
  maxSelections: 1,
  allowDuplicateSelections: false,
  options: [
    {
      id: "o-thin",
      name: "Thin",
      priceAdjustment: 0,
      plu: "THIN",
      deliveryTax: 0,
      isAvailable: true,
      pricesBySize: { "10": 0, "12": 0, "14": 0 },
      skuPlus: {},
    },
    {
      id: "o-stuffed",
      name: "Stuffed crust",
      priceAdjustment: 2,
      plu: "STUF",
      deliveryTax: 0,
      isAvailable: true,
      // The whole reason a sized product has to nest: £2 on a 10 inch,
      // £4 on a 14 inch.
      pricesBySize: { "10": 2, "12": 3, "14": 4 },
      skuPlus: {},
    },
  ],
};

const ITEM = {
  id: "item-marg",
  name: "Margharita",
  description: null,
  basePrice: 8,
  plu: "MARG",
  deliveryTax: 0,
  imageUrl: null,
  isAvailable: true,
};

/** Run the real publisher's product builder without standing up Nest. */
function publishProducts(Service: any) {
  const svc = Object.create(Service.prototype);
  return svc.toSrcProducts(
    { item: ITEM, priceOverride: null },
    new Map([[ITEM.id, SKUS]]),
    new Map(),
    new Map([["g-base", BASE_GROUP]]),
    null,
  );
}

const categories = (products: any[]) => [
  { id: "cat-pizza", name: "Pizzas", products },
];

describe("Deliveroo round trip — a sized pizza survives publish → import", () => {
  const { payload } = buildDeliverooMenu({
    menuName: "Pizzas",
    siteId: "site-1",
    categories: categories(publishProducts(DeliverooMenuPublishService)) as any,
  });
  const imported = classifyDeliverooMenu(payload as any);
  const pizza = imported.products.find((p) => p.externalId === ITEM.id)!;

  it("comes back as one product with its three sizes", () => {
    expect(imported.products).toHaveLength(1);
    expect(pizza.hasMultipleSkus).toBe(true);
    expect(pizza.productSkus.map((s) => s.name)).toEqual([
      "10 inch",
      "12 inch",
      "14 inch",
    ]);
  });

  it("comes back at the prices it went out at, not the differences", () => {
    // Publishing sends 8.00 with sizes at +0/+2/+4. Reading those as the size
    // prices would put a 10 inch on the POS at £0.00.
    expect(pizza.productSkus.map((s) => s.price)).toEqual([8, 10, 12]);
    expect(pizza.price).toBe(8);
  });

  it("keeps each size's own PLU", () => {
    expect(pizza.productSkus.map((s) => s.plu)).toEqual(["M10", "M12", "M14"]);
  });

  it("folds the per-size copies back into ONE Base group", () => {
    // Publishing emits g-base__10, g-base__12 and g-base__14. Importing all
    // three would leave the operator with three Base groups to maintain, and
    // republishing would split those into nine.
    const bases = imported.modifierGroups.filter((g) => g.name === "Base");
    expect(bases).toHaveLength(1);
    expect(bases[0]!.externalId).toBe("g-base");
    expect(bases[0]!.minSelections).toBe(1);
    expect(bases[0]!.maxSelections).toBe(1);
  });

  it("recovers the per-size crust prices onto the single option", () => {
    const stuffed = imported.modifiers.filter(
      (m) => m.name === "Stuffed crust",
    );
    expect(stuffed).toHaveLength(1);
    expect(stuffed[0]!.pricesBySize).toEqual({ "10": 2, "12": 3, "14": 4 });
  });

  it("hangs the Base group off every size", () => {
    // A sized product routes its groups through the selected SKU, so this is
    // what makes the crust list appear at all once a size is picked.
    for (const sku of pizza.productSkus) {
      expect(sku.modifierGroups).toEqual(["g-base"]);
    }
  });

  it("leaves no size group or per-size copy behind as a modifier group", () => {
    const ids = imported.modifierGroups.map((g) => g.externalId);
    expect(ids).toEqual(["g-base"]);
  });

  it("doesn't list the sizes as modifiers as well", () => {
    expect(imported.modifiers.map((m) => m.name)).toEqual(
      expect.not.arrayContaining(["10 inch", "12 inch", "14 inch"]),
    );
  });
});

describe("Uber round trip — a sized pizza survives publish → import", () => {
  const { payload } = buildUberEatsMenu({
    menuName: "Pizzas",
    categories: categories(publishProducts(UberEatsMenuPublishService)),
  } as any);
  const imported = classifyUberMenu(payload as any);
  const pizza = imported.products.find((p) => p.externalId === ITEM.id)!;

  it("comes back as one product with its three sizes", () => {
    expect(pizza.hasMultipleSkus).toBe(true);
    expect(pizza.productSkus.map((s) => s.name)).toEqual([
      "10 inch",
      "12 inch",
      "14 inch",
    ]);
  });

  it("comes back at the prices it went out at", () => {
    expect(pizza.productSkus.map((s) => s.price)).toEqual([8, 10, 12]);
    expect(pizza.price).toBe(8);
  });

  it("folds the per-size copies back into ONE Base group", () => {
    const bases = imported.modifierGroups.filter((g) => g.name === "Base");
    expect(bases).toHaveLength(1);
    expect(bases[0]!.externalId).toBe("g-base");
  });

  it("recovers the per-size crust prices onto the single option", () => {
    const stuffed = imported.modifiers.filter(
      (m) => m.name === "Stuffed crust",
    );
    expect(stuffed).toHaveLength(1);
    expect(stuffed[0]!.pricesBySize).toEqual({ "10": 2, "12": 3, "14": 4 });
  });

  it("hangs the Base group off every size", () => {
    for (const sku of pizza.productSkus) {
      expect(sku.modifierGroups).toEqual(["g-base"]);
    }
  });
});
