// ── Phase BN — nested modifier groups ───────────────────────────────────────
//
// A modifier group can hang off an OPTION instead of a product:
//
//   Big Boss Burger
//   └── Make It a Meal (group)
//       └── Make It a Meal +£3.99 (option)
//           ├── Choose Side (group)
//           │   └── Fries (option)
//           │       └── Dip (group) → Garlic Mayo
//           └── Choose Drink (group)
//
// This module turns "the groups on this product" + "what the customer has
// ticked so far" into the tree the picker renders, the flat list the cart and
// the kitchen ticket consume, and the list of still-unanswered required
// questions. It lives in @orderhub/shared for the same reason the pricing
// maths does: the till, the storefront and the kiosk must agree to the penny,
// and a second copy of this walk is how they'd start disagreeing.
//
// The walk only descends into options that are actually SELECTED. That's what
// makes deselecting "Make It a Meal" drop the £3.99, the fries and the dip
// from the price in one step, and what stops a hidden sub-selection being
// charged for a branch the customer closed.

import {
  getModifierPlu,
  getModifierPrice,
  isModifierAvailable,
  type PriceableModifier,
  type SelectedModifier,
} from "./menu-pricing";

/** Mirrors MAX_NESTING_DEPTH on the API — the two must not disagree. */
export const MAX_NESTING_DEPTH = 3;

export interface NestableOption extends PriceableModifier {
  /** Groups this option opens when chosen. Ordered. */
  nestedGroupIds?: string[] | null;
  sortOrder?: number;
}

export interface NestableGroup {
  id: string;
  name: string;
  selectionType?: "VARIANT" | "ADDON" | null;
  minSelections?: number | null;
  maxSelections?: number | null;
  /**
   * "Extra cheese × 2". When true the same option may be taken more than
   * once, up to the group's own maxSelections, which counts COPIES and not
   * distinct options — two garlic sauces spend a max of 2.
   *
   * Stored on the group and already published to Deliveroo and Just Eat as
   * `repeatable`; the till and the storefront simply never honoured it.
   */
  allowDuplicateSelections?: boolean | null;
  options?: NestableOption[] | null;
}

export interface ModifierTreeOption {
  option: NestableOption;
  price: number;
  plu: string | null;
  selected: boolean;
  /** How many copies are taken. 0 when unselected, 1 for an ordinary tick. */
  quantity: number;
  /** Groups this option opens — populated only while it is selected. */
  children: ModifierTreeNode[];
}

export interface ModifierTreeNode {
  group: NestableGroup;
  /** Selection-state key for this group in THIS branch. See selectionKey. */
  key: string;
  depth: number;
  /** Option names from the root down to this group's parent. */
  ancestorNames: string[];
  /** The option that opened this group, or null at the top level. */
  parentOptionId: string | null;
  options: ModifierTreeOption[];
}

/**
 * Selection state is keyed by the whole branch, not by group id.
 *
 * The same group legitimately appears in two places at once — a "Dip" group
 * nested under both "Fries" and "Waffle Fries" is one group row. Keyed by
 * group id alone, ticking a dip under fries would tick it under waffle fries
 * too, and charge for both.
 */
export function selectionKey(
  ancestorOptionIds: string[],
  groupId: string,
): string {
  return [...ancestorOptionIds, groupId].join(">");
}

export function buildModifierTree(args: {
  rootGroups: NestableGroup[];
  /** Every group reachable by id, nested ones included. */
  groupsById: Map<string, NestableGroup>;
  /** groupKey → selected option ids. */
  selections: Record<string, string[]>;
  sizeKey?: string | null;
  audience?: "pos" | "customer";
  maxDepth?: number;
}): ModifierTreeNode[] {
  const {
    rootGroups,
    groupsById,
    selections,
    sizeKey = null,
    audience = "pos",
    maxDepth = MAX_NESTING_DEPTH,
  } = args;

  const walk = (
    groups: NestableGroup[],
    depth: number,
    ancestorOptionIds: string[],
    ancestorNames: string[],
    parentOptionId: string | null,
    // Groups already open above this point in THIS branch. A catalog can be
    // hand-edited into a cycle, and an unguarded walk would never return.
    branchGroupIds: ReadonlySet<string>,
  ): ModifierTreeNode[] => {
    if (depth > maxDepth) return [];
    const nodes: ModifierTreeNode[] = [];

    for (const group of groups) {
      if (!group || branchGroupIds.has(group.id)) continue;
      const key = selectionKey(ancestorOptionIds, group.id);
      const picked = selections[key] ?? [];
      const nextBranch = new Set(branchGroupIds).add(group.id);

      const options: ModifierTreeOption[] = [];
      for (const option of group.options ?? []) {
        if (!isModifierAvailable(option, sizeKey, { audience })) continue;
        // Selections are a LIST, not a set: a repeated id is a repeated
        // choice. That is what carries "× 2" through pricing and the ticket.
        const quantity = picked.filter((id) => id === option.id).length;
        const selected = quantity > 0;
        const childGroups = selected
          ? (option.nestedGroupIds ?? [])
              .map((id) => groupsById.get(id))
              .filter((g): g is NestableGroup => !!g)
          : [];

        options.push({
          option,
          price: getModifierPrice(option, sizeKey),
          plu: getModifierPlu(option, sizeKey),
          selected,
          quantity,
          children: walk(
            childGroups,
            depth + 1,
            [...ancestorOptionIds, option.id],
            [...ancestorNames, option.name],
            option.id,
            nextBranch,
          ),
        });
      }

      nodes.push({ group, key, depth, ancestorNames, parentOptionId, options });
    }

    return nodes;
  };

  return walk(rootGroups, 0, [], [], null, new Set());
}

/**
 * The flat selection list the cart, the server and the printer consume.
 *
 * Flat on purpose: `calculateCartItem` sums this array, so a nested selection
 * rolls its price up to the line total with no special case, and every
 * existing consumer that reads `.name` / `.price` / `.groupId` keeps working.
 * Depth-first, so a ticket prints the meal, then its side, then the side's dip.
 */
export function collectSelectedModifiers(
  nodes: ModifierTreeNode[],
): SelectedModifier[] {
  const out: SelectedModifier[] = [];

  const visit = (list: ModifierTreeNode[]) => {
    for (const node of list) {
      for (const entry of node.options) {
        if (!entry.selected) continue;
        // One entry PER COPY. The list stays flat and every consumer keeps
        // reading {name, price, groupId} unchanged, so the second cheese is
        // charged and printed by the same code that handles the first. Nested
        // children are walked once — a branch opens or it doesn't, and
        // charging its sub-selections twice would be wrong.
        for (let i = 0; i < entry.quantity; i++) {
          out.push({
            id: entry.option.id,
            name: entry.option.name,
            groupId: node.group.id,
            groupName: node.group.name,
            price: entry.price,
            plu: entry.plu,
            parentOptionId: node.parentOptionId,
            depth: node.depth,
            path: [...node.ancestorNames, entry.option.name],
          });
        }
        visit(entry.children);
      }
    }
  };

  visit(nodes);
  return out;
}

export interface UnmetRequirement {
  groupId: string;
  groupName: string;
  key: string;
  min: number;
  picked: number;
}

/**
 * Required groups that still need an answer.
 *
 * A nested group only counts once its parent option is selected — "Choose
 * Side" is not an unanswered question until the customer says they want the
 * meal. That falls out of the tree: an unselected option has no children.
 */
export function findUnmetRequirements(
  nodes: ModifierTreeNode[],
): UnmetRequirement[] {
  const out: UnmetRequirement[] = [];

  const visit = (list: ModifierTreeNode[]) => {
    for (const node of list) {
      const min = node.group.minSelections ?? 0;
      // Copies, not distinct options: "choose 2 sauces" is answered by two
      // of the same one when the group allows duplicates.
      const picked = node.options.reduce((n, o) => n + o.quantity, 0);
      if (picked < min) {
        out.push({
          groupId: node.group.id,
          groupName: node.group.name,
          key: node.key,
          min,
          picked,
        });
      }
      for (const entry of node.options) {
        if (entry.selected) visit(entry.children);
      }
    }
  };

  visit(nodes);
  return out;
}

/**
 * Applies a tick/untick, respecting the group's selection type and capacity.
 *
 * Returns a new selections object. Selections beneath a deselected option are
 * left in place rather than scrubbed: the tree stops descending into a closed
 * branch, so they can't be priced or printed while it's closed, and reopening
 * it restores what the customer had already chosen instead of silently
 * clearing their work.
 */
export function toggleModifierSelection(
  selections: Record<string, string[]>,
  args: {
    key: string;
    optionId: string;
    selectionType?: "VARIANT" | "ADDON" | null;
    maxSelections?: number | null;
    /** VARIANT groups that aren't required can be un-picked. */
    minSelections?: number | null;
    /** See NestableGroup.allowDuplicateSelections. */
    allowDuplicates?: boolean | null;
  },
): Record<string, string[]> {
  const current = selections[args.key] ?? [];

  if ((args.selectionType ?? "VARIANT") === "VARIANT") {
    // Re-tapping the chosen option clears it, but only where clearing is a
    // legal answer — a required pick-one must always hold exactly one.
    if (current.includes(args.optionId) && (args.minSelections ?? 0) === 0) {
      return { ...selections, [args.key]: [] };
    }
    return { ...selections, [args.key]: [args.optionId] };
  }

  const max = args.maxSelections ?? Infinity;

  // A group that allows duplicates has no "untick" in a single tap — tapping
  // again means "another one". Removal is the stepper's minus, below. Without
  // this branch the second tap removed the first, which is exactly the bug:
  // a group set to allow two of the same could only ever hold one.
  if (args.allowDuplicates) {
    if (current.length >= max) return selections;
    return { ...selections, [args.key]: [...current, args.optionId] };
  }

  if (current.includes(args.optionId)) {
    return {
      ...selections,
      [args.key]: current.filter((id) => id !== args.optionId),
    };
  }
  if (current.length >= max) return selections;
  return { ...selections, [args.key]: [...current, args.optionId] };
}

/**
 * Add or remove ONE copy of an option — the stepper behind "extra cheese × 2".
 *
 * Separate from toggleModifierSelection because the two answer different
 * questions: a tick is "do I want this at all", a step is "how many". Removing
 * the last copy closes the branch exactly as unticking would.
 */
export function adjustModifierQuantity(
  selections: Record<string, string[]>,
  args: {
    key: string;
    optionId: string;
    delta: number;
    maxSelections?: number | null;
  },
): Record<string, string[]> {
  const current = selections[args.key] ?? [];
  const max = args.maxSelections ?? Infinity;

  if (args.delta > 0) {
    if (current.length >= max) return selections;
    return { ...selections, [args.key]: [...current, args.optionId] };
  }

  const at = current.lastIndexOf(args.optionId);
  if (at === -1) return selections;
  const next = [...current];
  next.splice(at, 1);
  return { ...selections, [args.key]: next };
}

/** Index a flat group list by id, for `groupsById` above. */
export function indexGroups(
  ...lists: Array<Array<NestableGroup> | null | undefined>
): Map<string, NestableGroup> {
  const map = new Map<string, NestableGroup>();
  for (const list of lists) {
    for (const g of list ?? []) {
      if (g?.id && !map.has(g.id)) map.set(g.id, g);
    }
  }
  return map;
}

// ── Order lines ─────────────────────────────────────────────────────────────

/** What an order line stores per selected modifier. */
export interface OrderLineModifier {
  name: string;
  price: number;
  depth?: number;
  path?: string[];
  parentOptionId?: string | null;
}

/**
 * Maps a cart selection to the shape an order line stores.
 *
 * Every checkout path used to write `{name, price}` by hand, which quietly
 * threw away the nesting on the way to the kitchen: the ticket listed the
 * meal, the side and the dip as three unrelated extras. Going through one
 * function means adding a field can't reach three surfaces and miss the
 * fourth.
 */
export function toOrderLineModifier(m: {
  name: string;
  price: number;
  depth?: number | null;
  path?: string[] | null;
  parentOptionId?: string | null;
}): OrderLineModifier {
  return {
    name: m.name,
    price: m.price,
    ...(m.depth ? { depth: m.depth } : {}),
    ...(m.path?.length ? { path: m.path } : {}),
    ...(m.parentOptionId ? { parentOptionId: m.parentOptionId } : {}),
  };
}

// ── Printing / display ──────────────────────────────────────────────────────

/** How deep a selection sits. Absent on every pre-Phase-BN order line. */
export function modifierDepth(m: { depth?: number | null }): number {
  const d = m.depth ?? 0;
  return Number.isFinite(d) && d > 0 ? Math.min(Math.trunc(d), MAX_NESTING_DEPTH) : 0;
}

/**
 * Leading whitespace for a modifier line on a ticket or receipt.
 *
 * Hierarchy is shown by indentation rather than by repeating the ancestors on
 * every line: a 42-column thermal ticket has the width for
 * "        + Garlic Mayo" but not for the whole path on each row, and kitchen
 * staff read the indent faster than a repeated prefix.
 *
 *   1x  BIG BOSS BURGER
 *       + Make It a Meal
 *         + Fries
 *           + Garlic Mayo
 *         + Coke
 */
export function modifierIndent(
  m: { depth?: number | null },
  unit = "  ",
): string {
  return unit.repeat(modifierDepth(m));
}

/**
 * The single-line reading, for surfaces with room for it (order detail, KDS
 * expanded view): "Make It a Meal → Fries → Garlic Mayo".
 *
 * Falls back to the plain name for a flat selection or an order placed before
 * nesting existed.
 */
export function formatModifierPath(
  m: { path?: string[] | null; name: string },
  separator = " → ",
): string {
  return m.path?.length ? m.path.join(separator) : m.name;
}

/** True when any group in the catalog nests — lets callers skip the walk. */
export function hasNestedGroups(groups: NestableGroup[]): boolean {
  return groups.some((g) =>
    (g.options ?? []).some((o) => (o.nestedGroupIds?.length ?? 0) > 0),
  );
}

// ── Stepped picker ──────────────────────────────────────────────────────────
//
// The till and the kiosk ask one question per screen rather than presenting
// every group in a scroller. Scrolling is a browsing pattern; taking an order
// is a task, and a required group three screens down a scroll is a required
// group that gets missed.
//
// The step list is derived from the SAME tree the scrolling view renders, so
// the two can never disagree about what is being asked or what it costs.

/**
 * Every group to ask about, in the order to ask, depth-first.
 *
 * A nested group is only a question once its parent option is chosen, so the
 * list GROWS as the operator works: ticking "Make It a Meal" inserts "Choose
 * Side" and "Choose Drink" directly after it, and unticking removes them
 * again. Callers must therefore clamp their step index against the current
 * length rather than holding an index across changes.
 */
export function flattenModifierSteps(
  nodes: ModifierTreeNode[],
): ModifierTreeNode[] {
  const out: ModifierTreeNode[] = [];
  const walk = (list: ModifierTreeNode[]) => {
    for (const node of list) {
      out.push(node);
      for (const entry of node.options) {
        // Children are populated only while the option is selected, so this
        // naturally skips branches the operator hasn't opened.
        if (entry.selected && entry.children.length) walk(entry.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/** Has this group had its minimum answered? Drives whether Next is allowed. */
export function isStepSatisfied(node: ModifierTreeNode): boolean {
  const min = node.group.minSelections ?? 0;
  if (min <= 0) return true;
  // Copies, not distinct options — the same count findUnmetRequirements uses.
  // Counting distinct options meant "choose 2 sauces, repeats allowed" was
  // answered by two different sauces but NOT by two of the same one: the Next
  // button stayed dead with a full basket of garlic mayo on screen. The two
  // checks disagreeing is what made it look arbitrary — Add accepted the order
  // the step refused to advance past.
  return node.options.reduce((n, o) => n + o.quantity, 0) >= min;
}

/**
 * Should choosing an option here move straight on to the next question?
 *
 * Only for a pick-exactly-one group. Making the operator confirm a choice the
 * system already knows is final is the difference between a picker that feels
 * fast and one that feels like paperwork — but a multi-select group can't
 * auto-advance, because only the operator knows when they've finished adding
 * toppings.
 */
export function shouldAutoAdvance(node: ModifierTreeNode): boolean {
  const max = node.group.maxSelections ?? 1;
  const min = node.group.minSelections ?? 0;
  return max === 1 && min === 1;
}
