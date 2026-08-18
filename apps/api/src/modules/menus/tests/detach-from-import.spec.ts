// Two brands whose menus came out of the SAME HubRise catalog claim the same
// product refs, because the import stores HubRise's own product ids in
// MenuItem.externalId and publish uses them as the catalog ref.
//
// Live case: Clifton's "CLIFTON BURGERS" and "smashing burger" both hold a
// "Fries" with ref "bpxrqd3", so the composed publish refuses all twelve
// collisions. Detaching gives one menu's products refs of their own.

import { MenusService } from "../menus.service";
import {
  composeAutoMaster,
  findDuplicateRefs,
  type AutoMasterMember,
} from "../../integrations/hubrise/hubrise-auto-master.composer";
import { transformMenuToCatalog } from "../../integrations/hubrise/hubrise-catalog.service";

const product = (over: Record<string, any>) => ({
  hasMultipleSkus: false,
  basePrice: 5,
  productSkus: null,
  modifierGroupLinks: [],
  ...over,
});

/** The two menus as they exist before detaching: separate rows, same imported
 *  externalId, same generated PLU. */
const cliftonBurgers = (): AutoMasterMember => ({
  id: "menuClifton",
  name: "CLIFTON BURGERS",
  brandId: "brandClifton",
  brand: { id: "brandClifton", name: "Clifton Burgers" },
  pricingVariants: [],
  categories: [
    {
      id: "catC",
      name: "Sides",
      items: [
        {
          item: product({
            id: "iClifton",
            name: "Fries",
            externalId: "bpxrqd3",
            plu: "Fries",
            brandId: "brandClifton",
          }),
        },
      ],
    },
  ],
});

const smashingBurger = (over?: { externalId?: string | null; plu?: string }): AutoMasterMember => ({
  id: "menuSmashing",
  name: "smashing burger",
  brandId: "brandSmashing",
  brand: { id: "brandSmashing", name: "Smashing Burger" },
  pricingVariants: [],
  categories: [
    {
      id: "catS",
      name: "Sides",
      items: [
        {
          item: product({
            id: "iSmashing",
            name: "Fries",
            externalId: over && "externalId" in over ? over.externalId : "bpxrqd3",
            plu: over && "plu" in over ? over.plu : "Fries",
            brandId: "brandSmashing",
          }),
        },
      ],
    },
  ],
});

const refsOf = (members: AutoMasterMember[]) => {
  const composed = composeAutoMaster(members, { name: "Clifton" });
  return findDuplicateRefs(transformMenuToCatalog(composed.menu, new Map()), composed.itemOrigin);
};

describe("two menus imported from one HubRise catalog", () => {
  it("collide on both the product ref and the size ref", () => {
    const problems = refsOf([cliftonBurgers(), smashingBurger()]);
    expect(problems.some((p) => p.includes('product ref "bpxrqd3"'))).toBe(true);
    expect(problems.some((p) => p.includes('product size ref "Fries"'))).toBe(true);
    expect(problems[0]).toContain("CLIFTON BURGERS");
    expect(problems[0]).toContain("smashing burger");
  });

  it("stop colliding once one menu's products are detached", () => {
    // What detachMenuFromImport leaves behind: no externalId, a fresh PLU.
    const detached = smashingBurger({ externalId: null, plu: "prd-9x2k4m" });
    expect(refsOf([cliftonBurgers(), detached])).toEqual([]);
  });
});

describe("MenusService.detachMenuFromImport", () => {
  function harness(opts: {
    items: Array<{ id: string; externalId?: string | null; plu?: string | null; productSkus?: any }>;
    /** itemIds also linked into some OTHER live menu. */
    sharedWithOtherMenus?: string[];
  }) {
    const updates: any[] = [];
    const shared = new Set(opts.sharedWithOtherMenus ?? []);
    const prisma: any = {
      menu: { findFirst: async () => ({ id: "menuSmashing" }) },
      menuItemOnCategory: {
        findMany: async ({ where }: any) =>
          where.category?.menuId?.not
            ? opts.items.filter((i) => shared.has(i.id)).map((i) => ({ itemId: i.id }))
            : opts.items.map((i) => ({ itemId: i.id })),
      },
      menuItem: {
        findMany: async ({ where }: any) =>
          // seedUsedPlus scans by brand for existing PLUs; the detach path
          // fetches the specific rows by id.
          !where?.id?.in
            ? []
            : opts.items
            .filter((i) => where.id.in.includes(i.id))
            .map((i) => ({
              id: i.id,
              externalId: i.externalId ?? null,
              plu: i.plu ?? null,
              hasMultipleSkus: !!i.productSkus,
              productSkus: i.productSkus ?? null,
            })),
        update: async (call: any) => {
          updates.push(call);
          return {};
        },
      },
      modifierGroup: { findMany: async () => [] },
      modifierOption: { findMany: async () => [] },
      brand: { findMany: async () => [{ id: "brandSmashing" }] },
    };
    const service = Object.create(MenusService.prototype) as MenusService;
    (service as any).prisma = prisma;
    (service as any).logger = { log: () => {}, warn: () => {} };
    return { service, updates };
  }

  it("clears the imported ref and mints a fresh PLU", async () => {
    const { service, updates } = harness({
      items: [{ id: "iSmashing", externalId: "bpxrqd3", plu: "Fries" }],
    });

    const result = await service.detachMenuFromImport("menuSmashing", "t1");

    expect(result).toMatchObject({ detached: 1, skippedShared: 0 });
    expect(updates).toHaveLength(1);
    expect(updates[0].data.externalId).toBeNull();
    expect(updates[0].data.plu).toBeTruthy();
    expect(updates[0].data.plu).not.toBe("Fries");
  });

  it("re-PLUs every size of a multi-size product", async () => {
    const { service, updates } = harness({
      items: [
        {
          id: "iSmashing",
          externalId: "bpxrqd3",
          plu: "Fries",
          productSkus: [
            { name: "Regular", price: 3, plu: "Fries" },
            { name: "Large", price: 4, plu: "Fries_L" },
          ],
        },
      ],
    });

    await service.detachMenuFromImport("menuSmashing", "t1");

    const skus = updates[0].data.productSkus;
    expect(skus).toHaveLength(2);
    expect(skus[0].plu).not.toBe("Fries");
    expect(skus[1].plu).not.toBe("Fries_L");
    // Sizes keep everything else — a detach must not reprice anything.
    expect(skus[0]).toMatchObject({ name: "Regular", price: 3 });
    expect(skus[1]).toMatchObject({ name: "Large", price: 4 });
  });

  it("leaves products shared with another menu alone", async () => {
    // Re-reffing a row another menu also publishes would silently change what
    // THAT menu sends to HubRise.
    const { service, updates } = harness({
      items: [
        { id: "iShared", externalId: "shared1", plu: "SHARED" },
        { id: "iOwn", externalId: "own1", plu: "OWN" },
      ],
      sharedWithOtherMenus: ["iShared"],
    });

    const result = await service.detachMenuFromImport("menuSmashing", "t1");

    expect(result).toMatchObject({ detached: 1, skippedShared: 1 });
    expect(updates.map((u) => u.where.id)).toEqual(["iOwn"]);
  });

  it("does not churn a product that already has references of its own", async () => {
    const { service, updates } = harness({
      items: [{ id: "iLocal", externalId: null, plu: null }],
    });

    const result = await service.detachMenuFromImport("menuSmashing", "t1");

    expect(result).toMatchObject({ detached: 0, alreadyIndependent: 1 });
    expect(updates).toHaveLength(0);
  });
});
