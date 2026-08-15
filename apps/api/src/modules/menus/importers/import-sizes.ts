// ── Reading a sized product back off a marketplace ──────────────────────────
//
// Neither Deliveroo nor Uber Eats has a size concept, so publishing a sized
// product flattens it (see integrations/shared/publish-sizes.ts):
//
//   Margherita  £8.99                        ← product priced at its CHEAPEST size
//     Size (required, pick one)              ← group id `${itemId}__sizes`
//       10 inch  +£0.00                      ← choice price is a DELTA
//         └ Base   (group id `${groupId}__10`)
//             Stuffed +£2.00                 ← option id `${optionId}__10`
//       12 inch  +£3.00
//         └ Base   (group id `${groupId}__12`)
//             Stuffed +£3.00
//
// This module is the inverse. It matters for two different reasons:
//
//   1. THE DELTA. A marketplace adds a modifier's price to the item's, so a
//      12 inch reads back as "+£3.00", not "£11.99". Importing that number
//      straight into a SKU turns an £11.99 pizza into a £3.00 one. This is
//      true of ANY marketplace menu with a size group, not just our own
//      round trips — Deliveroo menus authored by hand price sizes the same
//      way, because it's the only way the platform can express them.
//
//   2. THE COPIES. `Base` above is ONE group in our model whose Stuffed
//      option costs £2 at 10 inch and £3 at 12 inch (`pricesBySize`).
//      Publishing has to emit it as one copy per size because no marketplace
//      can price a modifier according to another modifier's selection.
//      Read back naively, the operator's tidy pizza turns into three
//      near-identical "Base" groups — and every republish would re-split
//      what they'd merged. Folding the copies restores the single group.
//
// Fold detection keys on the `__<size-slug>` suffix that publishing writes,
// so it only ever fires on the exact shape we emit. A marketplace menu that
// genuinely has different groups per size (the shape publishing produces for
// someone else's data) keeps them as separate groups, which is correct — they
// really are different groups there.

import { extractSizeKey } from "@orderhub/shared";

/**
 * Words that mark a required pick-one group as a SIZE rather than a choice.
 *
 * Structure alone can't tell a size from "Choose your sauce" — both are
 * pick-exactly-one. Deliberately narrow: an earlier draft also matched
 * base/crust/small/medium/large and promptly turned a Crust group (Thin /
 * Deep pan) into sizes. A crust is a style, not a size. Erring narrow means
 * an oddly-named size group imports as a modifier group and someone fixes it
 * in a minute; erring wide silently rewrites real choice groups across a
 * whole menu.
 */
export const SIZE_WORDS = /\b(size|sizes|inch|inches)\b|["”]/i;

/** A required pick-one group whose name agrees that it's a size. */
export function isSizeGroup(g: {
  name: string;
  minSelections: number;
  maxSelections: number;
}): boolean {
  // A size you can skip isn't a size.
  if (g.minSelections !== 1 || g.maxSelections !== 1) return false;
  return SIZE_WORDS.test(g.name || "");
}

/** Must stay identical to the publishers' `sizeSlug` — it's the same suffix. */
export function sizeSlug(key: string): string {
  return String(key).replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "x";
}

/** The size key a modifier's `pricesBySize` is keyed by. */
export function sizeKeyOf(sizeName: string): string {
  return extractSizeKey(sizeName) ?? sizeName;
}

// ── Inputs ──────────────────────────────────────────────────────────────────

/** One choice inside the size group, as the platform returned it. */
export interface SizeChoice {
  externalId: string;
  name: string;
  /** The marketplace price — a delta above the product price, not the total. */
  price: number;
  plu: string;
  /** Groups this choice opens. Our per-size copies, or genuinely nested ones. */
  nestedGroupIds: string[];
}

export interface RawGroup {
  externalId: string;
  name: string;
  minSelections: number;
  maxSelections: number;
  allowDuplicateSelections: boolean;
  optionExternalIds: string[];
}

export interface RawOption {
  externalId: string;
  name: string;
  price: number;
  plu: string;
  isAvailable: boolean;
}

// ── Outputs ─────────────────────────────────────────────────────────────────

/** One row of the product's `productSkus[]`. */
export interface FoldedSku {
  name: string;
  plu: string;
  /** The real price of this size: product base + the marketplace delta. */
  price: number;
  /**
   * External group ids for THIS size. A sized product routes its groups
   * through the selected SKU — the pickers read `selectedSku.modifierGroups`
   * and ignore the product's own links — so this is what makes a 12 inch
   * offer a different crust list than a 10 inch. The writer translates these
   * external ids to local ids once the groups have been upserted.
   */
  modifierGroups: string[];
}

/** Per-size prices recovered for one option, to merge onto its modifier row. */
export interface OptionPricing {
  pricesBySize: Record<string, number>;
  skuPlus: Record<string, string>;
}

export interface FoldedProduct {
  skus: FoldedSku[];
  /** Copies folded away — must NOT also be written as standalone rows. */
  consumedGroupIds: Set<string>;
  consumedOptionIds: Set<string>;
  /**
   * Canonical groups that existed only as per-size copies, so nothing in the
   * payload carries them any more and they have to be rebuilt.
   */
  rebuiltGroups: RawGroup[];
  rebuiltOptions: RawOption[];
  /** Canonical option id → the per-size prices recovered for it. */
  pricing: Map<string, OptionPricing>;
}

/**
 * Turn a marketplace size group back into `productSkus[]`.
 *
 * `productPrice` is the item's own price, which every size choice's delta is
 * added to. Pass 0 for a platform that prices the choices absolutely — the
 * arithmetic then reduces to "the choice price is the size price", which is
 * how a Deliveroo menu that leaves the item at £0.00 already behaved.
 */
export function foldSizedProduct(args: {
  productPrice: number;
  sizes: SizeChoice[];
  /** Groups on the product itself — they apply whichever size is picked. */
  productGroupIds: string[];
  groupById: (id: string) => RawGroup | undefined;
  optionById: (id: string) => RawOption | undefined;
  /** Group ids the payload carries in its own right (so we don't rebuild them). */
  payloadGroupIds: Set<string>;
}): FoldedProduct {
  const out: FoldedProduct = {
    skus: [],
    consumedGroupIds: new Set(),
    consumedOptionIds: new Set(),
    rebuiltGroups: [],
    rebuiltOptions: [],
    pricing: new Map(),
  };

  // Canonical group id → the group we're rebuilding, and the options seen so
  // far. Built across ALL sizes, since each size only carries its own copy.
  const rebuilding = new Map<string, RawGroup>();
  const rebuiltOptionById = new Map<string, RawOption>();

  for (const size of args.sizes) {
    const sizeKey = sizeKeyOf(size.name);
    const slug = `__${sizeSlug(sizeKey)}`;
    const skuGroupIds: string[] = [];

    for (const gid of size.nestedGroupIds) {
      const group = args.groupById(gid);
      if (!group) continue;

      // Not one of our copies — a group genuinely nested under this size.
      // Keep it as it is; it really does belong to this size alone.
      if (!gid.endsWith(slug)) {
        skuGroupIds.push(gid);
        continue;
      }

      const canonicalId = gid.slice(0, -slug.length);
      // A suffix with nothing in front of it isn't our convention.
      if (!canonicalId) {
        skuGroupIds.push(gid);
        continue;
      }

      out.consumedGroupIds.add(gid);
      skuGroupIds.push(canonicalId);

      // Rebuild the canonical group unless the payload still has one — a
      // group shared with a product that ISN'T sized comes back unsuffixed
      // too, and the payload's copy is the one to keep.
      if (!args.payloadGroupIds.has(canonicalId) && !rebuilding.has(canonicalId)) {
        rebuilding.set(canonicalId, {
          externalId: canonicalId,
          name: group.name,
          minSelections: group.minSelections,
          maxSelections: group.maxSelections,
          allowDuplicateSelections: group.allowDuplicateSelections,
          optionExternalIds: [],
        });
      }
      const canonicalGroup = rebuilding.get(canonicalId);

      for (const oid of group.optionExternalIds) {
        const option = args.optionById(oid);
        if (!option) continue;

        // Options are suffixed by the same rule as their group. One that
        // isn't is left alone rather than guessed at.
        const canonicalOptionId = oid.endsWith(slug)
          ? oid.slice(0, -slug.length)
          : oid;
        if (canonicalOptionId !== oid) out.consumedOptionIds.add(oid);

        // This size's price for this option — the whole point of the copies.
        const pricing = out.pricing.get(canonicalOptionId) ?? {
          pricesBySize: {},
          skuPlus: {},
        };
        pricing.pricesBySize[sizeKey] = option.price;
        if (option.plu) pricing.skuPlus[sizeKey] = option.plu;
        out.pricing.set(canonicalOptionId, pricing);

        if (canonicalGroup && !canonicalGroup.optionExternalIds.includes(canonicalOptionId)) {
          canonicalGroup.optionExternalIds.push(canonicalOptionId);
        }
        if (canonicalOptionId !== oid && !rebuiltOptionById.has(canonicalOptionId)) {
          rebuiltOptionById.set(canonicalOptionId, {
            ...option,
            externalId: canonicalOptionId,
            // The default price for a size we have no entry for. The first
            // size's is as good as any — `pricesBySize` answers every size
            // that actually exists.
            price: option.price,
          });
        }
      }
    }

    out.skus.push({
      name: size.name,
      plu: size.plu,
      price: round2(args.productPrice + size.price),
      // Product-level groups apply to every size; the per-size ones are this
      // size's alone. Product-level first so the picker's order is stable.
      modifierGroups: [...args.productGroupIds, ...skuGroupIds],
    });
  }

  out.rebuiltGroups = [...rebuilding.values()];
  out.rebuiltOptions = [...rebuiltOptionById.values()];
  return out;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
