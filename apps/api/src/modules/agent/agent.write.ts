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
      "Edit an existing product/menu item: name, description, single price, availability, image, OR its SIZE TIERS. To give an item multiple sizes (e.g. 10\"→£10, 12\"→£11) pass `sizes` — this converts a single-price item into a multi-size one. Use search_products to get the itemId. Reversible. Confirm with the operator, then confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        basePrice: { type: "number", description: "Single flat price. Omit when using sizes." },
        sizes: {
          type: "array",
          description: "Size tiers. Providing 2+ makes the item multi-size (base price becomes the cheapest).",
          items: {
            type: "object",
            properties: { name: { type: "string" }, price: { type: "number" } },
            required: ["name", "price"],
          },
        },
        isAvailable: { type: "boolean" },
        imageUrl: { type: "string", description: "Usually set by generate_item_image, not by hand." },
        confirmed: { type: "boolean" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "set_category_sizes",
    description:
      "Apply the SAME size tiers (e.g. 10\"→£10, 12\"→£11) to EVERY item in one category/section of a menu — the correct way to 'set sizes for all pizzas'. Runs as one bulk call (no per-item looping). Use list_menus for the menuId and get_menu to see category names. Confirm with the operator first, then confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        menuId: { type: "string" },
        categoryName: { type: "string", description: "The section name, e.g. 'Pizzas' (case-insensitive)." },
        sizes: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, price: { type: "number" } },
            required: ["name", "price"],
          },
        },
        confirmed: { type: "boolean" },
      },
      required: ["menuId", "categoryName", "sizes"],
      additionalProperties: false,
    },
  },
  {
    name: "set_category_prices",
    description:
      "Set the SAME base price on EVERY item in one category/section of a menu — the correct way to 'make all pizzas £7.80'. Runs as ONE bulk call; never loop update_item per item for this. Only touches the base price: sizes, crusts, toppings and every other modifier price are left exactly as they are. Use list_menus for the menuId and get_menu to see category names. Confirm with the operator first, then confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        menuId: { type: "string" },
        categoryName: {
          type: "string",
          description: "The section name, e.g. 'Pizzas' (case-insensitive).",
        },
        price: { type: "number", description: "New base price for every item in the section." },
        confirmed: { type: "boolean" },
      },
      required: ["menuId", "categoryName", "price"],
      additionalProperties: false,
    },
  },
  {
    name: "add_modifier_group_to_category",
    description:
      "Add a modifier group (e.g. 'Choose your crust' or 'Extra toppings') to EVERY item in a category/section — the right tool for 'add these options to all pizzas'. For MULTI-SIZE items each size gets its OWN separate group, so 10\" and 12\" price independently (they never share a group). Give per-size option prices with pricesBySize keyed by the exact size name (e.g. {\"10\\\"\": 2.5, \"12\\\"\": 3}), or a flat price for all sizes. Runs as one bulk call. Use get_menu for category names + exact item size names. Confirm first, then confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        menuId: { type: "string" },
        categoryName: { type: "string" },
        group: {
          type: "object",
          properties: {
            name: { type: "string" },
            selectionType: { type: "string", enum: ["VARIANT", "ADDON"], description: "VARIANT = pick one; ADDON = pick several." },
            minSelections: { type: "number" },
            maxSelections: { type: "number" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  price: { type: "number", description: "Flat extra charge (0 if free). Omit if using pricesBySize." },
                  pricesBySize: {
                    type: "object",
                    description: "Per-size price keyed by the item's size name, e.g. {\"10\\\"\": 2.5, \"12\\\"\": 3}.",
                    additionalProperties: { type: "number" },
                  },
                },
                required: ["name"],
              },
            },
          },
          required: ["name", "selectionType", "options"],
        },
        confirmed: { type: "boolean" },
      },
      required: ["menuId", "categoryName", "group"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_modifier_group_from_category",
    description:
      "Remove a modifier group (by name) from EVERY item in a category — detaches it from items and their sizes and deletes the now-unused group. Use this to clean up duplicate/unwanted groups before re-adding a clean one. Matches ALL groups with that name (so duplicates are cleared together). Confirm first, then confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        menuId: { type: "string" },
        categoryName: { type: "string" },
        groupName: { type: "string", description: "Name of the group to remove, e.g. 'Extra toppings'." },
        confirmed: { type: "boolean" },
      },
      required: ["menuId", "categoryName", "groupName"],
      additionalProperties: false,
    },
  },
  {
    name: "set_modifier_prices",
    description:
      "Change the PRICE of options in an EXISTING modifier group, in place — NO need to remove and re-add. This is the correct tool for 'make the 12\" stuffed crust £3' or 'set all extra toppings to £2.50'. Per-size prices MERGE with what's already there, so setting the 12\" price leaves the 10\" price untouched (the previously-impossible 'change just one size tier' case). Target options by name via `options`, or use `allOptions` to price every option in the group the same. Use get_menu first to see the group's option names and each item's EXACT size names. Reversible (set the price back). Confirm with the operator, then confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        menuId: { type: "string" },
        categoryName: { type: "string", description: "The section the group is on, e.g. 'Pizzas'." },
        groupName: { type: "string", description: "The existing group to edit, e.g. 'Choose your crust'." },
        options: {
          type: "array",
          description: "Per-option price edits, matched by option name (case-insensitive).",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              price: { type: "number", description: "Flat extra charge for this option (0 for free). Applies across sizes." },
              sizePrices: {
                type: "object",
                description: "Per-size price keyed by the item's EXACT size name from get_menu, e.g. {\"12\\\"\": 3}. Merges — only the sizes you list change; other sizes keep their current price.",
                additionalProperties: { type: "number" },
              },
            },
            required: ["name"],
          },
        },
        allOptions: {
          type: "object",
          description: "Apply the same price to EVERY option in the group, e.g. '£2.50 for all extra toppings'. Anything named in `options` overrides this.",
          properties: {
            price: { type: "number" },
            sizePrices: { type: "object", additionalProperties: { type: "number" } },
          },
        },
        confirmed: { type: "boolean" },
      },
      required: ["menuId", "categoryName", "groupName"],
      additionalProperties: false,
    },
  },
  {
    name: "add_modifier_group_to_item",
    description:
      "Create a modifier group and attach it to ONE item (same shape as add_modifier_group_to_category but for a single itemId). Confirm first, then confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        group: {
          type: "object",
          properties: {
            name: { type: "string" },
            selectionType: { type: "string", enum: ["VARIANT", "ADDON"] },
            minSelections: { type: "number" },
            maxSelections: { type: "number" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  price: { type: "number" },
                  pricesBySize: { type: "object", additionalProperties: { type: "number" } },
                },
                required: ["name"],
              },
            },
          },
          required: ["name", "selectionType", "options"],
        },
        confirmed: { type: "boolean" },
      },
      required: ["itemId", "group"],
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
