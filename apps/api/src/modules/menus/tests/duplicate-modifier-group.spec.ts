import { MenusService } from "../menus.service";

// Duplicating a modifier group has to produce something the operator can
// rename and reprice without touching the original. That means brand-new
// ModifierOption rows with brand-new PLUs — not a second reference to the
// same modifiers, which is what "Add Existing" does and the opposite of what
// duplicate means.

const TENANT = "t1";

const SOURCE = {
  id: "g1",
  brandId: "b1",
  locationId: "loc1",
  name: "Please select your extra toppings",
  description: null,
  plu: "MG-OLD",
  minSelections: 1,
  maxSelections: 3,
  isRequired: true,
  selectionType: "ADDON",
  allowDuplicateSelections: true,
  visibleToCustomers: true,
  sortOrder: 4,
  menuIds: ["menu-a"],
  options: [
    {
      id: "o1",
      name: "Chicken",
      description: null,
      plu: "MOD-OLD1",
      priceAdjustment: 0.8,
      pricesBySize: { "10": 0.8 },
      skuPlus: { "10": "TOP-CHK-10" },
      platformPricingOverrides: {},
      imageUrl: null,
      allergens: [],
      isDefault: true,
      isAvailable: true,
      visibleToCustomers: true,
      deliveryTax: 0,
      takeawayTax: 0,
      eatInTax: 0,
      nestedGroupId: null,
      modifierGroupIds: ["g1", "g-other"],
    },
  ],
};

/** Attached to g1 through modifierGroupIds[], owned elsewhere. */
const ARRAY_ATTACHED = {
  id: "o2",
  name: "Sweetcorn",
  description: null,
  plu: "MOD-OLD2",
  priceAdjustment: 0.9,
  pricesBySize: {},
  skuPlus: {},
  platformPricingOverrides: {},
  imageUrl: null,
  allergens: [],
  isDefault: false,
  isAvailable: true,
  visibleToCustomers: true,
  deliveryTax: 0,
  takeawayTax: 0,
  eatInTax: 0,
  nestedGroupId: null,
  modifierGroupIds: ["g1"],
  sortOrder: 1,
};

function makeService(opts: { arrayAttached?: boolean } = {}) {
  const created: any[] = [];
  let pluSeq = 0;
  const prisma: any = {
    modifierGroup: {
      findUnique: async () => JSON.parse(JSON.stringify(SOURCE)),
      create: async (a: any) => {
        created.push(a);
        return { id: "g-copy", ...a.data };
      },
    },
    modifierOption: {
      findMany: async () => (opts.arrayAttached ? [ARRAY_ATTACHED] : []),
    },
  };
  const svc = new MenusService(
    prisma,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  (svc as any).assertBrandAccess = async () => ({ id: "b1" });
  (svc as any).plu = {
    generateUnique: async (kind: string) => `${kind}-NEW-${++pluSeq}`,
  };
  return { svc, created };
}

const dataOf = (created: any[]) => created[0].data;
const optionsOf = (created: any[]) => created[0].data.options.create;

describe("duplicateModifierGroup", () => {
  it("gives the copy a fresh group PLU", async () => {
    const { svc, created } = makeService();
    await svc.duplicateModifierGroup("g1", TENANT);
    expect(dataOf(created).plu).toBe("modifierGroup-NEW-1");
    expect(dataOf(created).plu).not.toBe(SOURCE.plu);
  });

  it("creates brand-new modifiers rather than reusing the originals", async () => {
    const { svc, created } = makeService();
    await svc.duplicateModifierGroup("g1", TENANT);
    const [opt] = optionsOf(created);
    expect(opt.id).toBeUndefined(); // a create, not a connect
    expect(opt.plu).not.toBe("MOD-OLD1");
    expect(opt.name).toBe("Chicken");
  });

  it("copies the modifiers that are only array-attached", async () => {
    const { svc, created } = makeService({ arrayAttached: true });
    await svc.duplicateModifierGroup("g1", TENANT);
    expect(optionsOf(created).map((o: any) => o.name)).toEqual([
      "Chicken",
      "Sweetcorn",
    ]);
  });

  it("issues a distinct PLU per modifier", async () => {
    const { svc, created } = makeService({ arrayAttached: true });
    await svc.duplicateModifierGroup("g1", TENANT);
    const plus = optionsOf(created).map((o: any) => o.plu);
    expect(new Set(plus).size).toBe(plus.length);
  });

  it("does not array-attach the copy's modifiers back to the source group", async () => {
    const { svc, created } = makeService();
    await svc.duplicateModifierGroup("g1", TENANT);
    expect(optionsOf(created)[0].modifierGroupIds).toBeUndefined();
  });

  it("clears per-size PLUs, which would otherwise collide with the source", async () => {
    const { svc, created } = makeService();
    await svc.duplicateModifierGroup("g1", TENANT);
    expect(optionsOf(created)[0].skuPlus).toEqual({});
    // Prices are not PLUs — those carry over.
    expect(optionsOf(created)[0].pricesBySize).toEqual({ "10": 0.8 });
  });

  it("keeps the group's settings and location", async () => {
    const { svc, created } = makeService();
    await svc.duplicateModifierGroup("g1", TENANT);
    const d = dataOf(created);
    expect(d.locationId).toBe("loc1");
    expect(d.selectionType).toBe("ADDON");
    expect(d.minSelections).toBe(1);
    expect(d.maxSelections).toBe(3);
    expect(d.allowDuplicateSelections).toBe(true);
  });

  it("marks the copy in its name and attaches it to no menu", async () => {
    const { svc, created } = makeService();
    await svc.duplicateModifierGroup("g1", TENANT);
    expect(dataOf(created).name).toBe(
      "Please select your extra toppings (copy)",
    );
    expect(dataOf(created).menuIds).toEqual([]);
  });
});
