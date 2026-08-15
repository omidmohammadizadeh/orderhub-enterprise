import {
  resolveSkuModifierGroups,
  collectOptionGroupOwners,
} from "../importers/menu-writer.service";

// A multi-SKU product routes its modifier groups through the SELECTED SKU:
// the picker reads `selectedSku.modifierGroups` and never looks at the
// product's own group links. Both size-producing importers emitted
// `modifierGroups: []` on every SKU and left the back-fill to the writer,
// which never did it — so a Deliveroo menu where six "Choose Size" groups
// converted was six products showing their sizes and not one topping.
//
// The ids on a SKU must be LOCAL ModifierGroup ids. The classifier only knows
// the platform's external ids, so translating them is the writer's job and
// this is the function that does it.

const EXT_TO_LOCAL = new Map([
  ["grp-extras", "local-extras"],
  ["grp-sauce", "local-sauce"],
]);

describe("resolveSkuModifierGroups", () => {
  it("gives a SKU with no groups of its own the product's groups", () => {
    const out = resolveSkuModifierGroups(
      [{ modifierGroups: [] }, { modifierGroups: [] }],
      ["local-extras", "local-sauce"],
      EXT_TO_LOCAL,
    );
    expect(out.map((s) => s.modifierGroups)).toEqual([
      ["local-extras", "local-sauce"],
      ["local-extras", "local-sauce"],
    ]);
  });

  it("translates a SKU's own external ids to local ones", () => {
    const out = resolveSkuModifierGroups(
      [{ modifierGroups: ["grp-extras"] }],
      ["local-extras", "local-sauce"],
      EXT_TO_LOCAL,
    );
    // Its own list wins — this is the per-size case, not "inherit everything".
    expect(out[0].modifierGroups).toEqual(["local-extras"]);
  });

  it("leaves ids it doesn't recognise alone", () => {
    // Already-local ids, written by the dashboard rather than an import.
    const out = resolveSkuModifierGroups(
      [{ modifierGroups: ["local-handmade"] }],
      ["local-extras"],
      EXT_TO_LOCAL,
    );
    expect(out[0].modifierGroups).toEqual(["local-handmade"]);
  });

  it("keeps every other field on the SKU", () => {
    const out = resolveSkuModifierGroups(
      [{ name: '12 inch', plu: "S12", price: 11.99, modifierGroups: [] } as any],
      ["local-extras"],
      EXT_TO_LOCAL,
    );
    expect(out[0]).toEqual({
      name: '12 inch',
      plu: "S12",
      price: 11.99,
      modifierGroups: ["local-extras"],
    });
  });

  it("gives each SKU its own array", () => {
    // Shared array references would let editing one size's groups in the
    // dashboard silently change every other size.
    const out = resolveSkuModifierGroups(
      [{ modifierGroups: [] }, { modifierGroups: [] }],
      ["local-extras"],
      EXT_TO_LOCAL,
    );
    expect(out[0].modifierGroups).not.toBe(out[1].modifierGroups);
  });

  it("drops nothing and adds nothing for a product with no groups", () => {
    const out = resolveSkuModifierGroups([{ modifierGroups: [] }], [], EXT_TO_LOCAL);
    expect(out[0].modifierGroups).toEqual([]);
  });

  it("handles a flat product with no SKUs at all", () => {
    expect(resolveSkuModifierGroups([], ["local-extras"], EXT_TO_LOCAL)).toEqual([]);
    expect(resolveSkuModifierGroups(undefined as any, [], EXT_TO_LOCAL)).toEqual([]);
  });
});

// ── Option → group membership ────────────────────────────────────────────────
//
// One modifier can belong to several groups, and Deliveroo shares them freely.
// The reparenting pass used to run inside the group loop and `set` the array
// to the single group being processed, so each pass overwrote the last: an
// option in two groups ended up listed only under whichever group came last,
// and the others rendered as "(0 modifiers)" with their options apparently
// gone from the dashboard.

const G = new Map([
  ["g-flavour", "local-flavour"],
  ["g-addons", "local-addons"],
  ["g-side", "local-side"],
]);
const M = new Map([
  ["o-cheese", "local-cheese"],
  ["o-fries", "local-fries"],
]);

const group = (externalId: string, modifierExternalIds: string[]) => ({
  externalId,
  modifierExternalIds,
});

describe("collectOptionGroupOwners", () => {
  it("keeps an option in every group that holds it", () => {
    const owners = collectOptionGroupOwners(
      [group("g-flavour", ["o-cheese"]), group("g-addons", ["o-cheese"])],
      G,
      M,
    );
    expect(owners.get("local-cheese")).toEqual(["local-flavour", "local-addons"]);
  });

  it("makes the first group to claim an option its primary", () => {
    // owners[0] becomes ModifierOption.groupId.
    const owners = collectOptionGroupOwners(
      [group("g-addons", ["o-cheese"]), group("g-flavour", ["o-cheese"])],
      G,
      M,
    );
    expect(owners.get("local-cheese")![0]).toBe("local-addons");
  });

  it("doesn't list the same group twice", () => {
    const owners = collectOptionGroupOwners(
      [group("g-side", ["o-fries", "o-fries"])],
      G,
      M,
    );
    expect(owners.get("local-fries")).toEqual(["local-side"]);
  });

  it("skips groups and options that never got local ids", () => {
    const owners = collectOptionGroupOwners(
      [group("g-ghost", ["o-cheese"]), group("g-side", ["o-ghost"])],
      G,
      M,
    );
    expect(owners.size).toBe(0);
  });

  it("handles a flat menu with one group per option", () => {
    const owners = collectOptionGroupOwners(
      [group("g-flavour", ["o-cheese"]), group("g-side", ["o-fries"])],
      G,
      M,
    );
    expect(owners.get("local-cheese")).toEqual(["local-flavour"]);
    expect(owners.get("local-fries")).toEqual(["local-side"]);
  });
});
