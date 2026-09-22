// Deliveroo's modifier "type" — what a modifier group IS, in their words.
//
// Their Menu API guidelines: "Please provide the modifier type for all your
// modifications, whenever available." Nothing in a group's name or settings
// says which of these it is ("Extras" could be three of them), so the
// operator picks it per group and we never guess. Stored on
// ModifierGroup.metadata.deliverooModifierType.
//
// Shared so the dashboard dropdown and the API's validation are the same list.
// The values are Deliveroo's enum from the Menu API upload reference, verbatim.
//
// Two of Deliveroo's values are left out on purpose: "bundle-item" is set by
// the meal-deal publisher on a deal's sections, and "size-modification" on the
// size group sized products publish with. Offering either on an ordinary
// group would only let an operator mislabel it.

export const DELIVEROO_MODIFIER_TYPE_KEY = "deliverooModifierType";

export const DELIVEROO_MODIFIER_TYPES = [
  {
    value: "add-ingredient",
    label: "Add an ingredient",
    example: "Extra cheese, add bacon",
  },
  {
    value: "remove-ingredient",
    label: "Remove an ingredient",
    example: "No onions, no pickles",
  },
  {
    value: "product-variation",
    label: "Variation of the product",
    example: "Spicy or mild, thin or deep crust",
  },
  {
    value: "cooking-instruction",
    label: "Cooking instruction",
    example: "Well done, medium rare",
  },
  {
    value: "add-separate-condiment",
    label: "Separate condiment",
    example: "Dips and sauces on the side",
  },
  {
    value: "up-sell-existing-items",
    label: "Upsell another menu item",
    example: "Make it a meal, add a drink",
  },
  {
    value: "gift-wrap",
    label: "Gift wrap",
    example: "Wrap as a gift",
  },
] as const;

export type DeliverooGroupModifierType = (typeof DELIVEROO_MODIFIER_TYPES)[number]["value"];

const VALUES = new Set<string>(DELIVEROO_MODIFIER_TYPES.map((t) => t.value));

export function isDeliverooGroupModifierType(v: unknown): v is DeliverooGroupModifierType {
  return typeof v === "string" && VALUES.has(v);
}

/** The type an operator chose for a group, from its metadata; null if none / unknown. */
export function deliverooModifierTypeOf(metadata: unknown): DeliverooGroupModifierType | null {
  const v =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)[DELIVEROO_MODIFIER_TYPE_KEY]
      : undefined;
  return isDeliverooGroupModifierType(v) ? v : null;
}
