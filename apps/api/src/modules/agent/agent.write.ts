// ── Admin agent WRITE tool definitions (Phase 2) ────────────────────────────
//
// Only the Claude-facing schemas live here. Execution is dispatched by
// AgentService, which owns the injected services (MenusService, AiMenuImporter,
// MenuAvailabilityService) — so every write goes through the SAME validated,
// audited service methods the dashboard buttons use. No raw DB writes.
//
// SAFETY: every write tool takes `confirmed: boolean`. The agent must set it
// true ONLY after the operator has explicitly approved the change in chat; the
// dispatcher refuses (returns needsConfirmation) when it isn't true. All writes
// here are reversible (edit back, un-86, unpublish) — there are deliberately NO
// delete/bulk-destroy tools.

export const WRITE_TOOL_DEFS = [
  {
    name: "build_menu",
    description:
      "Create a COMPLETE new menu in one go — categories, items (with size pricing), and shared modifier groups with their options. This is the correct way to 'build a menu' or add modifier groups/modifiers to a NEW menu: pass the whole structure at once (do NOT create items one-by-one). Runs as one atomic, validated transaction. Ask the operator to confirm the plan first, then call with confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        brandId: { type: "string", description: "Brand the menu belongs to (from list_brands)." },
        menuName: { type: "string" },
        menuType: {
          type: "string",
          enum: ["DELIVERY", "DELIVERY_AND_PICKUP"],
          description: "Defaults to DELIVERY_AND_PICKUP.",
        },
        locationId: { type: "string", description: "Optional home location (from list_locations)." },
        categories: {
          type: "array",
          description: "Menu sections in order.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    price: { type: "number", description: "Single price. Omit when sizes[] is used." },
                    sizes: {
                      type: "array",
                      description: "Use for multi-size items (e.g. 10\"/12\"/14\").",
                      items: {
                        type: "object",
                        properties: { name: { type: "string" }, price: { type: "number" } },
                        required: ["name", "price"],
                      },
                    },
                    modifierGroupKeys: {
                      type: "array",
                      items: { type: "string" },
                      description: "Keys into the top-level modifierGroups this item offers.",
                    },
                  },
                  required: ["name"],
                },
              },
            },
            required: ["name", "items"],
          },
        },
        modifierGroups: {
          type: "array",
          description: "Shared option groups referenced by items via modifierGroupKeys.",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "Stable id used in items' modifierGroupKeys (e.g. 'sauce')." },
              name: { type: "string" },
              selectionType: {
                type: "string",
                enum: ["VARIANT", "ADDON"],
                description: "VARIANT = pick exactly one (e.g. a sauce). ADDON = pick several (e.g. extra toppings).",
              },
              minSelections: { type: "number" },
              maxSelections: { type: "number" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    priceAdjustment: { type: "number", description: "Extra charge for this option (0 if free)." },
                  },
                  required: ["name"],
                },
              },
            },
            required: ["key", "name", "selectionType", "options"],
          },
        },
        confirmed: { type: "boolean", description: "Set true ONLY after the operator approves." },
      },
      required: ["brandId", "menuName", "categories"],
      additionalProperties: false,
    },
  },
  {
    name: "update_item",
    description:
      "Edit an existing product/menu item: name, description, price, availability, or its image URL. Use search_products to get the itemId first. Reversible. Confirm with the operator, then call with confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        basePrice: { type: "number" },
        isAvailable: { type: "boolean" },
        imageUrl: { type: "string", description: "Usually set by generate_item_image, not by hand." },
        confirmed: { type: "boolean" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "snooze_item",
    description:
      "86 an item — mark it unavailable. Optionally scope to one location and/or one channel; default is all channels at all locations until manually turned back on. Reversible via unsnooze_item. Confirm first, then confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        locationId: { type: "string", description: "Optional — 86 at just this location." },
        channel: { type: "string", description: "Optional channel; default ALL." },
        confirmed: { type: "boolean" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "unsnooze_item",
    description:
      "Un-86 an item — make it available again (reverse of snooze_item). Confirm first, then confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        locationId: { type: "string" },
        channel: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_item_image",
    description:
      "Generate a realistic AI food photo for ONE item from its name + description, and set it as the item's image. Use search_products for the itemId. Costs a small amount per image — confirm with the operator, then confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        styleHint: { type: "string", description: "Optional style note, e.g. 'served in a takeaway box'." },
        confirmed: { type: "boolean" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_menu_images",
    description:
      "Generate AI food photos for a WHOLE menu's items as a throttled background job (returns immediately; photos appear over a few minutes). By default only items missing a photo. This costs per image — always tell the operator roughly how many will be generated and get confirmation, then confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        menuId: { type: "string" },
        onlyMissing: { type: "boolean", description: "Default true — skip items that already have a photo." },
        styleHint: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["menuId"],
      additionalProperties: false,
    },
  },
  {
    name: "publish_menu",
    description:
      "Publish a menu so it goes live (status PUBLISHED). Use list_menus to get the menuId. Confirm with the operator first, then call with confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        menuId: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["menuId"],
      additionalProperties: false,
    },
  },
] as const;

export const WRITE_TOOL_NAMES = new Set<string>(
  WRITE_TOOL_DEFS.map((t) => t.name),
);
