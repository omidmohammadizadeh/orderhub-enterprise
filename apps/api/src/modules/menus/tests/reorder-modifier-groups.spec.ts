import * as fs from "fs";
import * as path from "path";
import { MenusService } from "../menus.service";

// Nest matches routes in declaration order, so a literal path declared after a
// parameterised sibling is unreachable — "reorder" would be read as a groupId
// and 404 as an unknown modifier group. Same trap as /customers/lookup.
describe("POST items/:itemId/modifier-groups/reorder", () => {
  it("is declared before the :groupId route that would swallow it", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../menus.controller.ts"),
      "utf8",
    );
    const at = (d: string) => {
      const m = new RegExp(
        `^\\s*${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        "m",
      ).exec(src);
      return m ? m.index : -1;
    };
    const reorder = at('@Post("items/:itemId/modifier-groups/reorder")');
    const byId = at('@Post("items/:itemId/modifier-groups/:groupId")');
    expect(reorder).toBeGreaterThan(-1);
    expect(byId).toBeGreaterThan(-1);
    expect(reorder).toBeLessThan(byId);
  });
});

describe("reorderItemModifierGroups", () => {
  function build(linked: string[]) {
    const updates: any[] = [];
    const prisma: any = {
      modifierGroupOnItem: {
        findMany: async () => linked.map((groupId) => ({ groupId })),
        update: (args: any) => {
          updates.push(args);
          return args;
        },
      },
      $transaction: async (ops: any[]) => ops,
    };
    const svc = Object.create(MenusService.prototype) as any;
    svc.prisma = prisma;
    svc.assertItemAccess = jest.fn(async () => ({ id: "i1" }));
    return { svc, updates };
  }
  const orderOf = (u: any[]) =>
    u
      .slice()
      .sort((a, b) => a.data.sortOrder - b.data.sortOrder)
      .map((x) => x.where.itemAndGroup ?? x.where.itemId_groupId.groupId);

  it("writes sortOrder in the order the operator dragged them into", async () => {
    const { svc, updates } = build(["crust", "base", "toppings"]);
    await svc.reorderItemModifierGroups("i1", ["base", "crust", "toppings"], "t1");
    expect(orderOf(updates)).toEqual(["base", "crust", "toppings"]);
  });

  it("ignores an id that is not linked rather than failing the whole reorder", async () => {
    // The editor sends what is on screen; a group detached in another tab
    // must not take the rest down with it.
    const { svc, updates } = build(["crust", "base"]);
    await svc.reorderItemModifierGroups("i1", ["base", "GONE", "crust"], "t1");
    expect(orderOf(updates)).toEqual(["base", "crust"]);
  });

  it("keeps a group the caller omitted, placing it after the listed ones", async () => {
    // A stale editor must never silently drop a group to the top.
    const { svc, updates } = build(["crust", "base", "extra"]);
    await svc.reorderItemModifierGroups("i1", ["base", "crust"], "t1");
    expect(orderOf(updates)).toEqual(["base", "crust", "extra"]);
  });

  it("checks the item belongs to the tenant before touching anything", async () => {
    const { svc } = build(["crust"]);
    await svc.reorderItemModifierGroups("i1", ["crust"], "t1");
    expect(svc.assertItemAccess).toHaveBeenCalledWith("i1", "t1");
  });
});

describe("reorderModifierGroupOptions", () => {
  function build(owned: string[]) {
    const updates: any[] = [];
    const prisma: any = {
      modifierOption: {
        findMany: async () => owned.map((id) => ({ id })),
        update: (args: any) => {
          updates.push(args);
          return args;
        },
      },
      $transaction: async (ops: any[]) => ops,
    };
    const svc = Object.create(MenusService.prototype) as any;
    svc.prisma = prisma;
    svc.assertModifierGroupAccess = jest.fn(async () => undefined);
    return { svc, updates };
  }
  const orderOf = (u: any[]) =>
    u
      .slice()
      .sort((a, b) => a.data.sortOrder - b.data.sortOrder)
      .map((x) => x.where.id);

  it("numbers the group's own modifiers in the order on screen", async () => {
    const { svc, updates } = build(["small", "medium", "large"]);
    await svc.reorderModifierGroupOptions("g1", ["large", "small", "medium"], "t1");
    expect(orderOf(updates)).toEqual(["large", "small", "medium"]);
  });

  it("never renumbers a modifier shared in from another group", async () => {
    // Its sortOrder is its place in its own group; writing it here would
    // reshuffle that group behind the operator's back.
    const { svc, updates } = build(["small", "large"]);
    await svc.reorderModifierGroupOptions("g1", ["shared", "large", "small"], "t1");
    expect(orderOf(updates)).toEqual(["large", "small"]);
  });

  it("keeps an owned modifier the caller left out, after the listed ones", async () => {
    const { svc, updates } = build(["a", "b", "c"]);
    await svc.reorderModifierGroupOptions("g1", ["c", "a"], "t1");
    expect(orderOf(updates)).toEqual(["c", "a", "b"]);
  });

  it("checks the group belongs to the tenant first", async () => {
    const { svc } = build(["a"]);
    await svc.reorderModifierGroupOptions("g1", ["a"], "t1");
    expect(svc.assertModifierGroupAccess).toHaveBeenCalledWith("g1", "t1");
  });
});
