import { BadRequestException } from "@nestjs/common";
import {
  DELIVEROO_MODIFIER_TYPES,
  deliverooModifierTypeOf,
} from "@orderhub/shared";
import { withDeliverooModifierType } from "../../../menus/deliveroo-modifier-type";
import { buildDeliverooMenu, type DeliverooModifierType } from "../deliveroo-menu.transformer";

// Deliveroo: "Please provide the modifier type for all your modifications,
// whenever available." The operator picks it per group in the dashboard; it
// lives on ModifierGroup.metadata.deliverooModifierType and the uploader
// sends it as the modifier's `type`.

describe("saving a group's Deliveroo type", () => {
  it("sets it without disturbing whatever else is in metadata", () => {
    expect(withDeliverooModifierType({ importedFrom: "hubrise" }, "add-ingredient")).toEqual({
      importedFrom: "hubrise",
      deliverooModifierType: "add-ingredient",
    });
  });

  it("clears it when blanked, still keeping the rest", () => {
    const current = { importedFrom: "hubrise", deliverooModifierType: "add-ingredient" };
    expect(withDeliverooModifierType(current, null)).toEqual({ importedFrom: "hubrise" });
    expect(withDeliverooModifierType(current, "")).toEqual({ importedFrom: "hubrise" });
  });

  it("refuses a value Deliveroo doesn't have, naming the ones it does", () => {
    expect(() => withDeliverooModifierType({}, "extras")).toThrow(BadRequestException);
    expect(() => withDeliverooModifierType({}, "extras")).toThrow(/add-ingredient/);
  });

  it("refuses the two types we set ourselves, so a group can't be mislabelled as one", () => {
    // bundle-item is a meal-deal section; size-modification is the size group.
    expect(() => withDeliverooModifierType({}, "bundle-item")).toThrow(BadRequestException);
    expect(() => withDeliverooModifierType({}, "size-modification")).toThrow(BadRequestException);
  });

  it("starts from nothing when metadata was never an object", () => {
    expect(withDeliverooModifierType(null, "gift-wrap")).toEqual({ deliverooModifierType: "gift-wrap" });
    expect(withDeliverooModifierType([], "gift-wrap")).toEqual({ deliverooModifierType: "gift-wrap" });
  });
});

describe("reading it back for the upload", () => {
  it("returns the stored type", () => {
    expect(deliverooModifierTypeOf({ deliverooModifierType: "remove-ingredient" })).toBe(
      "remove-ingredient",
    );
  });

  it("returns null for none, or for anything that isn't one of Deliveroo's", () => {
    expect(deliverooModifierTypeOf({})).toBeNull();
    expect(deliverooModifierTypeOf(null)).toBeNull();
    expect(deliverooModifierTypeOf({ deliverooModifierType: "extras" })).toBeNull();
  });

  it("offers only values in Deliveroo's own enum", () => {
    // Compile-time: every dashboard option must be assignable to the
    // transformer's enum, which is copied from the Menu API reference.
    const values: DeliverooModifierType[] = DELIVEROO_MODIFIER_TYPES.map((t) => t.value);
    expect(values).toHaveLength(7);
  });
});

it("sends the operator's choice as the modifier's type", () => {
  const { payload } = buildDeliverooMenu({
    menuName: "M",
    siteId: "s",
    coverImageUrl: "https://x/c.jpg",
    categories: [
      {
        id: "c",
        name: "Burgers",
        products: [
          {
            id: "b",
            name: "Burger",
            price: 9,
            groups: [
              {
                id: "g-remove",
                name: "Remove",
                modifierType: "remove-ingredient",
                selectionType: "ADDON",
                options: [{ id: "o-onion", name: "No onions", price: 0 }],
              },
              {
                id: "g-sauce",
                name: "Sauce",
                options: [{ id: "o-bbq", name: "BBQ", price: 0 }],
              },
            ],
          },
        ],
      },
    ],
  });
  const byId = new Map(payload.menu.modifiers.map((m) => [m.id, m]));
  expect(byId.get("g-remove")!.type).toBe("remove-ingredient");
  expect(byId.get("g-sauce")).not.toHaveProperty("type");
});
