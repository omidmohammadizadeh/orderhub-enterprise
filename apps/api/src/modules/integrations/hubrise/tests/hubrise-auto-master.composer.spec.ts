// Composition rules for the auto-composed HubRise master menu.
//
// The operator edits one brand's menu and presses publish on it; we compose
// every brand's menu at that location into the single catalog HubRise allows.
// These tests pin the parts that decide whether each brand's storefront shows
// the right products afterwards.

import {
  composeAutoMaster,
  findDuplicateRefs,
  isAutoMasterMember,
  withAutoMasterFlag,
  type AutoMasterMember,
} from "../hubrise-auto-master.composer";
import { transformMenuToCatalog } from "../hubrise-catalog.service";

const item = (over: Record<string, any>) => ({
  hasMultipleSkus: false,
  basePrice: 5,
  modifierGroupLinks: [],
  ...over,
});

const alpha: AutoMasterMember = {
  id: "menuAlpha",
  name: "Alpha Menu",
  brandId: "brandA",
  brand: { id: "brandA", name: "Alpha" },
  pricingVariants: [
    {
      ref: "brandA__UBER_EATS",
      name: "Alpha — Uber Eats",
      channelKey: "UBER_EATS",
      brandId: "brandA",
      brandName: "Alpha",
    },
  ],
  categories: [
    {
      id: "catA",
      name: "Burgers",
      items: [{ item: item({ id: "iA", name: "Alpha Burger", plu: "A1", brandId: "brandA" }) }],
    },
  ],
};

const beta: AutoMasterMember = {
  id: "menuBeta",
  name: "Beta Menu",
  brandId: "brandB",
  brand: { id: "brandB", name: "Beta" },
  // No variants of its own — the composer must seed them, or Beta's products
  // publish unrestricted and show up inside Alpha's storefront.
  pricingVariants: [],
  categories: [
    {
      id: "catB",
      name: "Burgers",
      items: [{ item: item({ id: "iB", name: "Beta Burger", plu: "B1", brandId: "brandB" }) }],
    },
  ],
};

describe("composeAutoMaster", () => {
  it("includes every member brand's products regardless of who published", () => {
    const fromAlpha = composeAutoMaster([alpha, beta], { name: "Clifton" });
    const fromBeta = composeAutoMaster([beta, alpha], { name: "Clifton" });

    const names = (c: typeof fromAlpha) =>
      c.menu.categories.flatMap((cat: any) => cat.items.map((l: any) => l.item.name)).sort();

    expect(names(fromAlpha)).toEqual(["Alpha Burger", "Beta Burger"]);
    // Composition order must not depend on which brand pressed publish, or
    // category suffixes and refs would flap between publishes.
    expect(names(fromBeta)).toEqual(names(fromAlpha));
    expect(fromBeta.memberIds).toEqual(fromAlpha.memberIds);
  });

  it("keeps existing variant refs untouched and seeds brands that have none", () => {
    const composed = composeAutoMaster([alpha, beta], { name: "Clifton" });
    const refs = composed.menu.pricingVariants.map((v) => v.ref);

    // The operator has already selected this ref inside HubRise. Changing it
    // forces every operator to re-select their variant.
    expect(refs).toContain("brandA__UBER_EATS");
    // Seeded leaves use the same `${brandId}__${channelKey}` shape.
    expect(refs).toContain("brandB__UBER_EATS");
    expect(refs).toContain("brandB__DELIVEROO");
    expect(composed.seededBrandIds).toEqual(["brandB"]);
    // Alpha already had a leaf, so it is not re-seeded with the full preset set.
    expect(refs.filter((r) => r.startsWith("brandA__"))).toEqual(["brandA__UBER_EATS"]);
  });

  it("restricts each brand's products to that brand's variants once transformed", () => {
    const composed = composeAutoMaster([alpha, beta], { name: "Clifton" });
    const data = transformMenuToCatalog(composed.menu, new Map());

    const skuFor = (name: string) =>
      data.products.find((p) => p.name === name)!.skus![0] as any;

    expect(skuFor("Alpha Burger").restrictions.variant_refs).toEqual(["brandA__UBER_EATS"]);
    const betaRefs: string[] = skuFor("Beta Burger").restrictions.variant_refs;
    expect(betaRefs).toContain("brandB__UBER_EATS");
    expect(betaRefs.every((r) => r.startsWith("brandB__"))).toBe(true);
  });

  it("keeps a product in its own menu's brand even when tagged to another", () => {
    // Clifton Burgers' products carry another brand's tag. Letting the tag win
    // outright took whole categories off its live Uber Eats store — a variant
    // restriction only ever HIDES things, so getting it wrong is silent and
    // customer-facing. The menu's brand is always added.
    const misTagged: AutoMasterMember = {
      ...beta,
      categories: [
        {
          id: "catB",
          name: "Burgers",
          items: [{ item: item({ id: "iB", name: "Beta Burger", plu: "B1", brandId: "brandA" }) }],
        },
      ],
    };
    const composed = composeAutoMaster([alpha, misTagged], { name: "Clifton" });
    const data = transformMenuToCatalog(composed.menu, new Map());
    const refs: string[] = (data.products.find((p) => p.name === "Beta Burger")!.skus![0] as any)
      .restrictions.variant_refs;

    expect(refs).toContain("brandB__UBER_EATS");
    expect(refs).toContain("brandA__UBER_EATS");
  });

  it("keeps an untagged product in its menu's brand", () => {
    const untagged: AutoMasterMember = {
      ...beta,
      categories: [
        {
          id: "catB",
          name: "Burgers",
          items: [{ item: item({ id: "iB", name: "Beta Burger", plu: "B1" }) }],
        },
      ],
    };
    const composed = composeAutoMaster([alpha, untagged], { name: "Clifton" });
    const data = transformMenuToCatalog(composed.menu, new Map());
    const refs: string[] = (data.products.find((p) => p.name === "Beta Burger")!.skus![0] as any)
      .restrictions.variant_refs;

    expect(refs).toContain("brandB__UBER_EATS");
  });

  it("seeds variants from the brand TAGGED ON THE PRODUCTS, not the menu's owner", () => {
    // The live Clifton case: a menu imported under "Order Hub" (which is what
    // Menu.brandId ends up as) but whose products were tagged to Smashing
    // Burger. The variants — and therefore the HubRise storefront — must
    // follow the tag, not the import artefact.
    const imported: AutoMasterMember = {
      id: "menuImported",
      name: "smashing burger",
      brandId: "brandOrderHub",
      brand: { id: "brandOrderHub", name: "Order Hub" },
      pricingVariants: [],
      categories: [
        {
          id: "catI",
          name: "Smash",
          items: [
            { item: item({ id: "iS", name: "Smash Burger", plu: "S1", brandId: "brandSmash" }) },
          ],
        },
      ],
    };
    const composed = composeAutoMaster([imported], {
      name: "Clifton",
      brandNames: new Map([["brandSmash", "Smashing Burger"]]),
    });

    const refs = composed.menu.pricingVariants.map((v) => v.ref);
    expect(refs).toContain("brandSmash__UBER_EATS");
    expect(
      composed.menu.pricingVariants.find((v) => v.ref === "brandSmash__UBER_EATS")!.name,
    ).toBe("Smashing Burger — Uber Eats");

    // The product reaches Smashing Burger's storefront, which is what the
    // operator expressed by tagging it. The menu's own brand rides along —
    // brandsForItem never narrows — and the cure for a wrong one is
    // tagAllItemsBrand re-homing Menu.brandId, not hiding products.
    const data = transformMenuToCatalog(composed.menu, new Map());
    const restricted: string[] = (data.products[0].skus![0] as any).restrictions.variant_refs;
    expect(restricted).toContain("brandSmash__UBER_EATS");
  });

  it("folds a MenuItem shared by two menus into one product carrying both brands", () => {
    const shared = item({ id: "iShared", name: "Shared Dip", plu: "DIP", brandId: "brandA" });
    const a: AutoMasterMember = {
      ...alpha,
      categories: [{ id: "catA", name: "Sides", items: [{ item: shared }] }],
    };
    const b: AutoMasterMember = {
      ...beta,
      categories: [{ id: "catB", name: "Sides", items: [{ item: shared }] }],
    };
    const composed = composeAutoMaster([a, b], { name: "Clifton" });
    const data = transformMenuToCatalog(composed.menu, new Map());

    // One product — two products with the same ref would collide in HubRise.
    expect(data.products.filter((p) => p.name === "Shared Dip")).toHaveLength(1);
    expect(composed.sharedItemCount).toBe(1);
    const refs: string[] = (data.products[0].skus![0] as any).restrictions.variant_refs;
    expect(refs).toContain("brandA__UBER_EATS");
    expect(refs).toContain("brandB__UBER_EATS");
  });

  it("suffixes a category name only when two different brands use it", () => {
    const composed = composeAutoMaster([alpha, beta], { name: "Clifton" });
    const names = composed.menu.categories.map((c: any) => c.name);
    expect(names).toEqual(["Burgers", "Burgers (Beta)"]);
  });

  it("counts what each member contributed so a starved brand can be refused", () => {
    const emptyBeta: AutoMasterMember = { ...beta, categories: [{ id: "catB", name: "Burgers", items: [] }] };
    const composed = composeAutoMaster([alpha, emptyBeta], { name: "Clifton" });
    expect(composed.productCounts.get("menuAlpha")).toBe(1);
    expect(composed.productCounts.get("menuBeta")).toBe(0);
  });
});

describe("findDuplicateRefs", () => {
  it("catches two brands using the same PLU", () => {
    const clash: AutoMasterMember = {
      ...beta,
      categories: [
        {
          id: "catB",
          name: "Burgers",
          // Same PLU as Alpha's burger — legal in two separate menus, fatal
          // in one shared catalog.
          items: [{ item: item({ id: "iB", name: "Beta Burger", plu: "A1", brandId: "brandB" }) }],
        },
      ],
    };
    const composed = composeAutoMaster([alpha, clash], { name: "Clifton" });
    const data = transformMenuToCatalog(composed.menu, new Map());

    const problems = findDuplicateRefs(data);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("A1");
    expect(problems[0]).toContain("Alpha Burger");
    expect(problems[0]).toContain("Beta Burger");
  });

  it("names the two MENUS that collided, not just the product twice", () => {
    // "product ref X used by both \"Fries\" and \"Fries\"" is unactionable —
    // the operator needs to know which two menus to reconcile.
    const clash: AutoMasterMember = {
      ...beta,
      categories: [
        {
          id: "catB",
          name: "Burgers",
          items: [{ item: item({ id: "iB", name: "Fries", plu: "FRIES", brandId: "brandB" }) }],
        },
      ],
    };
    const withFries: AutoMasterMember = {
      ...alpha,
      categories: [
        {
          id: "catA",
          name: "Sides",
          items: [{ item: item({ id: "iA2", name: "Fries", plu: "FRIES", brandId: "brandA" }) }],
        },
      ],
    };
    const composed = composeAutoMaster([withFries, clash], { name: "Clifton" });
    const problems = findDuplicateRefs(
      transformMenuToCatalog(composed.menu, new Map()),
      composed.itemOrigin,
    );

    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("Alpha Menu");
    expect(problems[0]).toContain("Beta Menu");
  });

  it("passes a clean composition", () => {
    const composed = composeAutoMaster([alpha, beta], { name: "Clifton" });
    expect(findDuplicateRefs(transformMenuToCatalog(composed.menu, new Map()))).toEqual([]);
  });
});

describe("membership flag", () => {
  it("is off for every menu that has never opted in", () => {
    expect(isAutoMasterMember({ metadata: {} })).toBe(false);
    expect(isAutoMasterMember({ metadata: null })).toBe(false);
    expect(isAutoMasterMember({})).toBe(false);
    expect(isAutoMasterMember({ metadata: { hubriseAutoMaster: "yes" } })).toBe(false);
  });

  it("round-trips without dropping other metadata keys", () => {
    const on = withAutoMasterFlag({ importedBy: "ai" }, true);
    expect(on).toEqual({ importedBy: "ai", hubriseAutoMaster: true });
    expect(isAutoMasterMember({ metadata: on })).toBe(true);
    expect(withAutoMasterFlag(on, false)).toEqual({ importedBy: "ai" });
  });
});
