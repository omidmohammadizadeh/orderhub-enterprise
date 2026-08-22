"use client";

// Phase AZ — per-product channel pricing. Driven by the PRODUCT's brand(s)
// (set on the product form): for each brand you add the channels it sells on
// (Uber Eats / Deliveroo / Just Eat) right here, which creates the
// "Brand — Channel" variant (e.g. "Pizza Uno — Uber Eats") and registers it
// on the menu. Rows = base price (or each size) + every modifier option;
// columns = the brand's channels. Blank cell = default price. Saves:
//   - menu.pricingVariants (merges this product's brand×channel leaves)
//   - item overrides (single -> platformPricingOverrides; multi -> productSkus[].priceOverrides)
//   - modifier overrides (ModifierOption.platformPricingOverrides)
// which publish to HubRise as variants[] + price_overrides[].

import { Fragment, useEffect, useMemo, useState } from "react";
import { useCurrency } from "@/hooks/use-currency";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { X, Plus, Store } from "lucide-react";
import {
  CHANNEL_VARIANT_PRESETS,
  brandChannelRef,
  slugifyChannelKey,
  type PricingVariant,
} from "@orderhub/shared";
import { Button } from "@/components/ui/button";
import {
  productsClient,
  modifiersClient,
  modifierGroupsClient,
} from "@/lib/api/catalog.client";
import { brandsClient, menusClient } from "@/lib/api/menus.client";

interface Props {
  open: boolean;
  menuId: string;
  /** Product row from the menu detail (carries brandIds, productSkus, modifierGroupLinks). */
  product: any;
  /** The menu's current pricing variants (so we merge, not clobber, other brands). */
  variants: PricingVariant[];
  onClose: () => void;
}

type OvMap = Record<string, string>; // variantRef -> input string

const toStr = (m: Record<string, number> | null | undefined): OvMap => {
  const out: OvMap = {};
  for (const [k, v] of Object.entries(m ?? {})) out[k] = String(v);
  return out;
};

// Module-scope so its identity is stable across renders (a component defined
// inside the parent remounts every keystroke and drops input focus).
function Cell({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      type="number"
      step="0.01"
      min="0"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="h-8 w-24 rounded-md border border-zinc-200 px-2 text-sm tabular-nums focus:border-violet-400 focus:outline-none"
    />
  );
}

export function ProductVariantPricingModal({
  open,
  menuId,
  product,
  variants,
  onClose,
}: Props) {
  // Prices follow the selected location's currency, not a hardcoded pound.
  const { money, symbol } = useCurrency();
  const qc = useQueryClient();

  const { data: brands = [] } = useQuery({
    queryKey: ["brands"],
    queryFn: () => brandsClient.list(),
    enabled: open,
  });

  const multi =
    !!product?.hasMultipleSkus &&
    Array.isArray(product?.productSkus) &&
    product.productSkus.length > 0;

  // The modifier groups this product uses. Multi-SKU products attach groups
  // per size (productSkus[].modifierGroups holds IDs); single products via
  // modifierGroupLinks. Resolve by ID (brand-drift safe — a SKU group can
  // belong to a different brand than the product) so the rows always show.
  const referencedGroupIds = useMemo<string[]>(() => {
    const ids = new Set<string>();
    if (multi) {
      for (const s of product?.productSkus ?? [])
        for (const gid of s.modifierGroups ?? []) if (gid) ids.add(gid);
    } else {
      for (const l of product?.modifierGroupLinks ?? [])
        if (l.group?.id) ids.add(l.group.id);
    }
    return Array.from(ids);
  }, [multi, product]);

  const groupQueries = useQueries({
    queries: referencedGroupIds.map((id) => ({
      queryKey: ["catalog", "modifier-group", id],
      queryFn: () => modifierGroupsClient.get(id),
      enabled: open,
    })),
  });

  const modGroups = useMemo(() => {
    // Prefer the fetched group (carries options + platformPricingOverrides);
    // fall back to the link's embedded group object while it loads.
    const linkById = new Map<string, any>();
    for (const l of product?.modifierGroupLinks ?? [])
      if (l.group?.id) linkById.set(l.group.id, l.group);
    return referencedGroupIds
      .map((id, i) => groupQueries[i]?.data ?? linkById.get(id))
      .filter((g: any) => g && Array.isArray(g.options));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referencedGroupIds, groupQueries.map((q) => q.data), product]);

  // id -> group, for resolving each SKU's attached groups by id.
  const groupById = useMemo(() => {
    const m = new Map<string, any>();
    for (const l of product?.modifierGroupLinks ?? [])
      if (l.group?.id) m.set(l.group.id, l.group);
    referencedGroupIds.forEach((id, i) => {
      const d = groupQueries[i]?.data;
      if (d) m.set(id, d);
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referencedGroupIds, groupQueries.map((q) => q.data), product]);

  // Multi-SKU: show each size's own modifier groups under a size header so
  // the operator knows which modifiers belong to which size.
  const skuSections = useMemo(() => {
    if (!multi) return [] as Array<{ key: string; label: string; groups: any[] }>;
    return (product.productSkus as any[])
      .map((s, i) => ({
        key: `sku-${i}`,
        label: s.name || `Size ${i + 1}`,
        groups: (s.modifierGroups ?? [])
          .map((gid: string) => groupById.get(gid))
          .filter((g: any) => g && Array.isArray(g.options)),
      }))
      .filter((sec) => sec.groups.length > 0);
  }, [multi, product, groupById]);

  // The brand(s) this product belongs to (set on the product form).
  const productBrandIds = useMemo<string[]>(() => {
    const ids =
      Array.isArray(product?.brandIds) && product.brandIds.length
        ? product.brandIds
        : product?.brandId
          ? [product.brandId]
          : [];
    return Array.from(new Set(ids.filter(Boolean)));
  }, [product]);

  const brandLabel = (id: string) => {
    const matches = brands.filter((b) => b.name === brands.find((x) => x.id === id)?.name);
    const b = brands.find((x) => x.id === id);
    if (!b) return "Brand";
    // Disambiguate when two brands share a name (e.g. two "MONSTER BURGERZ").
    return matches.length > 1 ? `${b.name} · ${b.slug}` : b.name;
  };

  // Which channels are active per brand (init from the menu's existing
  // variants for these brands; operator can add more inline — including
  // custom channels beyond the 3 presets, e.g. Careem/Talabat/WhatsApp).
  // Keeping {channelKey, name} (not just the key) so a custom channel's
  // typed name survives — CHANNEL_VARIANT_PRESETS only covers the 3 presets.
  const [active, setActive] = useState<Record<string, Array<{ channelKey: string; name: string }>>>({});
  const [customChannel, setCustomChannel] = useState<Record<string, string>>({});
  const [itemOv, setItemOv] = useState<OvMap>({});
  const [skuOv, setSkuOv] = useState<OvMap[]>([]);
  const [optOv, setOptOv] = useState<Record<string, OvMap>>({});
  // Which brand's pricing table is expanded (one at a time).
  const [selectedBrand, setSelectedBrand] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    const init: Record<string, Array<{ channelKey: string; name: string }>> = {};
    for (const bId of productBrandIds) init[bId] = [];
    for (const v of variants ?? []) {
      const arr = v.brandId ? init[v.brandId] : undefined;
      if (arr && v.channelKey && !arr.some((c) => c.channelKey === v.channelKey)) {
        // Persisted name is "Brand — Channel" (see save() below) — take
        // everything after the first " — " as the channel-only label so a
        // custom channel's typed name round-trips correctly.
        const label = v.name.includes(" — ")
          ? v.name.split(" — ").slice(1).join(" — ")
          : v.name;
        arr.push({ channelKey: v.channelKey, name: label });
      }
    }
    setActive(init);
    setSelectedBrand((cur) =>
      cur && productBrandIds.includes(cur) ? cur : (productBrandIds[0] ?? ""),
    );
    setItemOv(toStr(product?.platformPricingOverrides));
    setSkuOv(
      multi
        ? (product.productSkus as any[]).map((s) => toStr(s.priceOverrides))
        : [],
    );
    setOptOv({});
  }, [open, variants, productBrandIds, product, multi]);

  // Seed modifier-option overrides separately: modGroups can arrive late
  // (brand groups load async for SKU-attached groups). Merge so a late load
  // adds rows without wiping any in-progress edits.
  useEffect(() => {
    if (!open) return;
    setOptOv((prev) => {
      const next = { ...prev };
      for (const g of modGroups)
        for (const opt of g.options)
          if (!(opt.id in next)) next[opt.id] = toStr(opt.platformPricingOverrides);
      return next;
    });
  }, [open, modGroups]);

  // Flattened brand×channel leaves currently shown (columns), grouped by brand.
  const leaves = useMemo(() => {
    const out: Array<{
      ref: string;
      brandId: string;
      brandName: string;
      channelKey: string;
      channelName: string;
    }> = [];
    for (const bId of productBrandIds) {
      const bName = brandLabel(bId);
      for (const ch of active[bId] ?? []) {
        out.push({
          ref: brandChannelRef(bId, ch.channelKey),
          brandId: bId,
          brandName: bName,
          channelKey: ch.channelKey,
          channelName: ch.name,
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productBrandIds, active, brands]);

  // Only the expanded brand's columns are shown in the table.
  const visibleLeaves = useMemo(
    () => leaves.filter((l) => l.brandId === selectedBrand),
    [leaves, selectedBrand],
  );

  const activeRefs = useMemo(() => new Set(leaves.map((l) => l.ref)), [leaves]);
  const numify = (m: OvMap = {}): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(m)) {
      const n = Number(v);
      if (activeRefs.has(k) && v !== "" && Number.isFinite(n) && n >= 0) out[k] = n;
    }
    return out;
  };

  const addChannel = (brandId: string, channelKey: string, name: string) =>
    setActive((prev) => ({
      ...prev,
      [brandId]: [...(prev[brandId] ?? []), { channelKey, name }],
    }));

  const removeChannel = (brandId: string, channelKey: string) =>
    setActive((prev) => ({
      ...prev,
      [brandId]: (prev[brandId] ?? []).filter((c) => c.channelKey !== channelKey),
    }));

  const addCustomChannel = (brandId: string) => {
    const name = (customChannel[brandId] ?? "").trim();
    const channelKey = slugifyChannelKey(name);
    if (!name || !channelKey) return;
    if ((active[brandId] ?? []).some((c) => c.channelKey === channelKey)) {
      setCustomChannel({ ...customChannel, [brandId]: "" });
      return;
    }
    addChannel(brandId, channelKey, name);
    setCustomChannel({ ...customChannel, [brandId]: "" });
  };

  const save = useMutation({
    mutationFn: async () => {
      // 1) Merge this product's brand×channel leaves into the menu's variants
      //    (preserve variants belonging to other brands).
      const others = (variants ?? []).filter(
        (v) => !v.brandId || !productBrandIds.includes(v.brandId),
      );
      const merged: PricingVariant[] = [
        ...others,
        ...leaves.map((l) => ({
          ref: l.ref,
          name: `${l.brandName} — ${l.channelName}`,
          channelKey: l.channelKey,
          brandId: l.brandId,
          brandName: brands.find((b) => b.id === l.brandId)?.name ?? l.brandName,
        })),
      ];
      await menusClient.updateMenu(menuId, { pricingVariants: merged });

      // 2) Item / size overrides.
      const productPatch: any = {};
      if (multi) {
        productPatch.hasMultipleSkus = true;
        productPatch.productSkus = (product.productSkus as any[]).map((s, i) => ({
          name: s.name,
          plu: s.plu,
          price: Number(s.price) || 0,
          modifierGroups: Array.isArray(s.modifierGroups) ? s.modifierGroups : [],
          priceOverrides: numify(skuOv[i]),
        }));
      } else {
        productPatch.platformPricingOverrides = numify(itemOv);
      }
      await productsClient.update(product.id, productPatch);

      // 3) Modifier option overrides.
      for (const [optId, map] of Object.entries(optOv)) {
        await modifiersClient.update(optId, {
          platformPricingOverrides: numify(map),
        } as any);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["menu", menuId] });
      qc.invalidateQueries({ queryKey: ["menus"] });
      qc.invalidateQueries({ queryKey: ["catalog", "products"] });
      onClose();
    },
  });

  if (!open) return null;

  const noBrand = productBrandIds.length === 0;

  // Render one modifier group (header + option rows). A plain function (not a
  // component) so the price inputs keep focus. `prefix` keeps keys unique when
  // the same group shows under more than one size.
  const renderGroup = (g: any, prefix = "") => (
    <Fragment key={`${prefix}g-${g.id}`}>
      <tr>
        <td
          colSpan={visibleLeaves.length + 1}
          className="sticky left-0 bg-white px-2 pt-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-400"
        >
          {g.name}
        </td>
      </tr>
      {g.options.map((o: any) => {
        const base = Number(o.priceAdjustment ?? 0);
        return (
          <tr key={`${prefix}${o.id}`}>
            <td className="sticky left-0 z-10 bg-white px-2 pl-4">
              <div className="text-sm text-zinc-700">{o.name}</div>
              <div className="text-[10px] text-zinc-400">
                default +{money(base)}
              </div>
            </td>
            {visibleLeaves.map((l) => (
              <td key={l.ref} className="px-2">
                <Cell
                  value={optOv[o.id]?.[l.ref] ?? ""}
                  onChange={(val) =>
                    setOptOv({
                      ...optOv,
                      [o.id]: { ...optOv[o.id], [l.ref]: val },
                    })
                  }
                  placeholder={base.toFixed(2)}
                />
              </td>
            ))}
          </tr>
        );
      })}
    </Fragment>
  );

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="my-8 w-full max-w-4xl rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 p-5">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              Channel pricing — {product?.name}
            </h2>
            <p className="text-[11px] text-zinc-500">
              Add the channels each brand sells on, then set the price. Blank =
              default price.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        {noBrand ? (
          <div className="p-8 text-center text-sm text-zinc-500">
            Tag this product's brand on the product form first (Edit product →
            Brands), then come back to set channel prices.
          </div>
        ) : (
          <div className="max-h-[62vh] space-y-4 overflow-auto p-5">
            {/* Brand tabs — click a brand to expand its pricing table. */}
            <div className="flex flex-wrap gap-1.5">
              {productBrandIds.map((bId) => {
                const isSel = bId === selectedBrand;
                const count = (active[bId] ?? []).length;
                return (
                  <button
                    key={bId}
                    onClick={() => setSelectedBrand(bId)}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-semibold ${
                      isSel
                        ? "border-violet-300 bg-violet-50 text-violet-700"
                        : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"
                    }`}
                  >
                    <Store className="h-3.5 w-3.5 opacity-70" />
                    {brandLabel(bId)}
                    {count > 0 && (
                      <span
                        className={`rounded-full px-1.5 text-[10px] ${
                          isSel ? "bg-violet-200 text-violet-800" : "bg-zinc-100 text-zinc-500"
                        }`}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {selectedBrand && (
              <>
                {/* Channel chips for the selected brand */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {(active[selectedBrand] ?? []).map((ch) => (
                    <span
                      key={ch.channelKey}
                      className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2.5 py-1 text-xs font-medium text-violet-700"
                    >
                      {ch.name}
                      <button
                        onClick={() => removeChannel(selectedBrand, ch.channelKey)}
                        className="text-violet-400 hover:text-violet-700"
                        aria-label="Remove channel"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  {CHANNEL_VARIANT_PRESETS.filter(
                    (c) => !(active[selectedBrand] ?? []).some((x) => x.channelKey === c.channelKey),
                  ).map((c) => (
                    <button
                      key={c.channelKey}
                      onClick={() => addChannel(selectedBrand, c.channelKey, c.name)}
                      className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 hover:border-violet-300 hover:bg-violet-50"
                    >
                      <Plus className="h-3 w-3" /> {c.name}
                    </button>
                  ))}
                  {/* Any other channel — Careem, Talabat, WhatsApp, Online
                      ordering, POS, etc. Not limited to presets. */}
                  <input
                    value={customChannel[selectedBrand] ?? ""}
                    onChange={(e) =>
                      setCustomChannel({ ...customChannel, [selectedBrand]: e.target.value })
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCustomChannel(selectedBrand);
                      }
                    }}
                    placeholder="Other channel…"
                    className="h-7 w-40 rounded-full border border-dashed border-zinc-200 bg-white px-3 text-xs focus:border-violet-400 focus:outline-none"
                  />
                  <button
                    onClick={() => addCustomChannel(selectedBrand)}
                    disabled={!(customChannel[selectedBrand] ?? "").trim()}
                    className="inline-flex shrink-0 items-center gap-1 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:border-violet-300 hover:bg-violet-50 disabled:opacity-40"
                  >
                    <Plus className="h-3 w-3" /> Add
                  </button>
                </div>

                {/* Pricing table for the selected brand */}
                {visibleLeaves.length === 0 ? (
                  <p className="rounded-md border border-dashed border-zinc-200 bg-white px-3 py-6 text-center text-xs text-zinc-500">
                    Add a channel above to set prices for {brandLabel(selectedBrand)}.
                  </p>
                ) : (
                  <table className="w-full border-separate border-spacing-y-1">
                    <thead>
                      <tr>
                        <th className="sticky left-0 z-10 bg-white px-2 pb-2 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                          Item / size
                        </th>
                        {visibleLeaves.map((l) => (
                          <th
                            key={l.ref}
                            className="px-2 pb-2 text-left text-[11px] font-medium text-zinc-600"
                          >
                            {l.channelName}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {!multi ? (
                        <tr>
                          <td className="sticky left-0 z-10 bg-white px-2">
                            <div className="text-sm font-medium text-zinc-800">
                              Base price
                            </div>
                            <div className="text-[10px] text-zinc-400">
                              default {money(Number(product?.basePrice ?? 0))}
                            </div>
                          </td>
                          {visibleLeaves.map((l) => (
                            <td key={l.ref} className="px-2">
                              <Cell
                                value={itemOv[l.ref] ?? ""}
                                onChange={(val) =>
                                  setItemOv({ ...itemOv, [l.ref]: val })
                                }
                                placeholder={Number(product?.basePrice ?? 0).toFixed(2)}
                              />
                            </td>
                          ))}
                        </tr>
                      ) : (
                        (product.productSkus as any[]).map((s, i) => (
                          <tr key={i}>
                            <td className="sticky left-0 z-10 bg-white px-2">
                              <div className="text-sm font-medium text-zinc-800">
                                {s.name || `Size ${i + 1}`}
                              </div>
                              <div className="text-[10px] text-zinc-400">
                                default {money((Number(s.price) || 0))}
                              </div>
                            </td>
                            {visibleLeaves.map((l) => (
                              <td key={l.ref} className="px-2">
                                <Cell
                                  value={skuOv[i]?.[l.ref] ?? ""}
                                  onChange={(val) =>
                                    setSkuOv(
                                      skuOv.map((row, idx) =>
                                        idx === i ? { ...row, [l.ref]: val } : row,
                                      ),
                                    )
                                  }
                                  placeholder={(Number(s.price) || 0).toFixed(2)}
                                />
                              </td>
                            ))}
                          </tr>
                        ))
                      )}

                      {multi
                        ? skuSections.map((sec) => (
                            <Fragment key={sec.key}>
                              <tr>
                                <td
                                  colSpan={visibleLeaves.length + 1}
                                  className="sticky left-0 bg-zinc-50 px-2 pt-4 pb-1 text-[11px] font-bold uppercase tracking-wider text-zinc-700"
                                >
                                  ▾ {sec.label} modifiers
                                </td>
                              </tr>
                              {sec.groups.map((g: any) => renderGroup(g, `${sec.key}-`))}
                            </Fragment>
                          ))
                        : modGroups.map((g: any) => renderGroup(g))}
                    </tbody>
                  </table>
                )}
              </>
            )}

            {modGroups.length > 0 && visibleLeaves.length > 0 && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                Modifier prices are shared wherever that option is used — editing
                here updates its channel price everywhere.
              </p>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-zinc-100 p-4">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          {!noBrand && (
            <Button
              size="sm"
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {save.isPending ? "Saving…" : "Save channel prices"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
