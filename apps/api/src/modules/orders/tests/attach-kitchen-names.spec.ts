import { OrdersService } from "../orders.service";

// The tablet builds its OWN print payload from the live-orders feed, so a
// translation that only exists in the server's KITCHEN_TICKET payload never
// reaches it — and the tablet is the only renderer that can draw CJK. These
// pin that the feed carries it, and that shops without the feature pay almost
// nothing for it.
function build(opts: {
  settings?: Record<string, unknown>;
  items?: any[];
  mods?: any[];
}) {
  const calls: string[] = [];
  const wheres: Record<string, any> = {};
  const prisma: any = {
    location: {
      findMany: async () => {
        calls.push("location");
        return [{ id: "loc-1", settings: opts.settings ?? {} }];
      },
    },
    menuItem: {
      findMany: async () => {
        calls.push("menuItem");
        return opts.items ?? [];
      },
    },
    modifierOption: {
      findMany: async (args: any) => {
        calls.push("modifierOption");
        wheres.modifierOption = args?.where;
        return opts.mods ?? [];
      },
    },
  };
  const svc = Object.create(OrdersService.prototype) as any;
  svc.prisma = prisma;
  svc.logger = { warn: () => {} };
  return { svc, calls, wheres };
}

const rows = () => [
  {
    locationId: "loc-1",
    brandId: "b1",
    tenantId: "t1",
    items: [
      {
        menuItemId: "mi1",
        name: "Salt & Pepper Chicken",
        modifiers: [{ name: "Extra spicy" }, { name: "No MSG" }],
      },
      { menuItemId: "mi2", name: "Egg Fried Rice", modifiers: [] },
    ],
  },
];

describe("attachKitchenNames", () => {
  it("attaches the kitchen name to items and modifiers", async () => {
    const { svc } = build({
      settings: { kitchenTicketSecondLanguage: true },
      items: [{ id: "mi1", secondLanguageName: "椒盐鸡" }],
      mods: [{ name: "Extra spicy", secondLanguageName: "多辣" }],
    });
    const out = await svc.attachKitchenNames(rows());
    expect(out[0].items[0].secondLanguageName).toBe("椒盐鸡");
    expect(out[0].items[0].modifiers[0].secondLanguageName).toBe("多辣");
  });

  it("leaves an untranslated item and modifier alone", async () => {
    // A half-translated menu must keep printing the original for the rest.
    const { svc } = build({
      settings: { kitchenTicketSecondLanguage: true },
      items: [{ id: "mi1", secondLanguageName: "椒盐鸡" }],
      mods: [{ name: "Extra spicy", secondLanguageName: "多辣" }],
    });
    const out = await svc.attachKitchenNames(rows());
    expect(out[0].items[1].secondLanguageName).toBeUndefined();
    expect(out[0].items[0].modifiers[1].secondLanguageName).toBeUndefined();
  });

  it("does NOTHING but one lookup when the location has it switched off", async () => {
    // This runs on the polled live-orders feed. Nearly every shop prints
    // English and must not pay for menu and modifier queries on every poll.
    const { svc, calls } = build({ settings: {} });
    const out = await svc.attachKitchenNames(rows());
    expect(calls).toEqual(["location"]);
    expect(out[0].items[0].secondLanguageName).toBeUndefined();
  });

  it("returns immediately when there are no orders", async () => {
    const { svc, calls } = build({ settings: { kitchenTicketSecondLanguage: true } });
    expect(await svc.attachKitchenNames([])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("returns the orders unchanged if the lookup throws", async () => {
    // A board that loads in English beats a board that does not load.
    const { svc } = build({ settings: { kitchenTicketSecondLanguage: true } });
    svc.prisma.menuItem.findMany = async () => {
      throw new Error("db down");
    };
    const r = rows();
    const out = await svc.attachKitchenNames(r);
    expect(out).toBe(r);
    expect(out[0].items[0].name).toBe("Salt & Pepper Chicken");
  });

  it("matches modifiers across the TENANT, not just the order's brand", async () => {
    // A modifier group is brand-wide when its locationId is null, and an
    // imported menu routinely references groups on a SIBLING brand of the same
    // tenant. Scoping to the order's brandId found none of those — translated
    // options still printed in English.
    const { svc, wheres } = build({
      settings: { kitchenTicketSecondLanguage: true },
      mods: [{ name: "Extra spicy", secondLanguageName: "多辣" }],
    });
    await svc.attachKitchenNames(rows());
    expect(wheres.modifierOption.group).toEqual({
      brand: { tenantId: { in: ["t1"] } },
    });
  });
});
