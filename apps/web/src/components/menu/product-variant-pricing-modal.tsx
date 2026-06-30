"use client";

// Phase AZ — per-product variant pricing matrix. Rows = the product's base
// price (or each size) plus every modifier option; columns = the menu's
// pricing variants. Each cell overrides that row's price for that variant;
// blank falls back to the default. Saves item overrides (single-price ->
// MenuItem.platformPricingOverrides; multi-size -> productSkus[].priceOverrides)
// and modifier overrides (ModifierOption.platformPricingOverrides). These
// publish to HubRise as price_overrides.

import { Fragment, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { CHANNEL_VARIANT_PRESETS, type PricingVariant } from "@orderhub/shared";
import { Button } from "@/components/ui/button";
import { productsClient, modifiersClient } from "@/lib/api/catalog.client";

interface Props {
  open: boolean;
  menuId: string;
  /** Product row from the menu detail (carries productSkus, modifierGroupLinks). */
  product: any;
  variants: PricingVariant[];
  onClose: () => void;
}

type OvMap = Record<string, string>; // variantRef -> input string

const numify = (m: OvMap = {}): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) {
    const n = Number(v);
    if (v !== "" && Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
};

const toStr = (m: Record<string, number> | null | undefined): OvMap => {
  const out: OvMap = {};
  for (const [k, v] of Object.entries(m ?? {})) out[k] = String(v);
  return out;
};

export function ProductVariantPricingModal({
  open,
  menuId,
  product,
  variants,
  onClose,
}: Props) {
  const qc = useQueryClient();

  const multi =
    !!product?.hasMultipleSkus && Array.isArray(product?.productSkus) &&
    product.productSkus.length > 0;

  const groups = useMemo(
    () =>
      (product?.modifierGroupLinks ?? [])
        .map((l: any) => l.group)
        .filter((g: any) => g && Array.isArray(g.options)),
    [product],
  );

  // Order columns brand-by-brand and build the grouped (brand) header.
  const orderedVariants = useMemo(() => {
    const order: string[] = [];
    const byBrand = new Map<string, PricingVariant[]>();
    for (const v of variants ?? []) {
      const key = v.brandId ?? "__none";
      if (!byBrand.has(key)) {
        byBrand.set(key, []);
        order.push(key);
      }
      byBrand.get(key)!.push(v);
    }
    return order.flatMap((k) => byBrand.get(k)!);
  }, [variants]);

  const brandHeader = useMemo(() => {
    const out: { label: string; count: number }[] = [];
    for (const v of orderedVariants) {
      const label = v.brandName ?? "Other";
      const last = out[out.length - 1];
      if (last && last.label === label) last.count++;
      else out.push({ label, count: 1 });
    }
    return out;
  }, [orderedVariants]);

  const channelLabel = (v: PricingVariant) =>
    CHANNEL_VARIANT_PRESETS.find((c) => c.channelKey === v.channelKey)?.name ??
    v.name;

  // ── State ──
  // Single-price item base overrides.
  const [itemOv, setItemOv] = useState<OvMap>(() =>
    toStr(product?.platformPricingOverrides),
  );
  // Per-size overrides (index-aligned with productSkus).
  const [skuOv, setSkuOv] = useState<OvMap[]>(() =>
    multi
      ? (product.productSkus as any[]).map((s) => toStr(s.priceOverrides))
      : [],
  );
  // Per-option overrides keyed by option id.
  const [optOv, setOptOv] = useState<Record<string, OvMap>>(() => {
    const init: Record<string, OvMap> = {};
    for (const g of groups)
      for (const o of g.options)
        init[o.id] = toStr(o.platformPricingOverrides);
    return init;
  });

  const save = useMutation({
    mutationFn: async () => {
      const tasks: Promise<any>[] = [];

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
      tasks.push(productsClient.update(product.id, productPatch));

      for (const [optId, map] of Object.entries(optOv)) {
        tasks.push(
          modifiersClient.update(optId, {
            platformPricingOverrides: numify(map),
          } as any),
        );
      }
      await Promise.all(tasks);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["menu", menuId] });
      qc.invalidateQueries({ queryKey: ["menus"] });
      qc.invalidateQueries({ queryKey: ["catalog", "products"] });
      onClose();
    },
  });

  if (!open) return null;

  const noVariants = !variants || variants.length === 0;

  const Cell = ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
  }) => (
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

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="my-8 w-full max-w-4xl rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 p-5">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              Channel pricing — {product?.name}
            </h2>
            <p className="text-[11px] text-zinc-500">
              Blank = uses the default price for that channel.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        {noVariants ? (
          <div className="p-8 text-center text-sm text-zinc-500">
            No pricing variants defined yet. Add some from the{" "}
            <span className="font-medium">Pricing variants</span> button on the
            menu first.
          </div>
        ) : (
          <div className="max-h-[60vh] overflow-auto p-5">
            <table className="w-full border-separate border-spacing-y-1">
              <thead>
                <tr>
                  <th
                    rowSpan={2}
                    className="sticky left-0 z-10 bg-white px-2 pb-2 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-400"
                  >
                    Item / size
                  </th>
                  {brandHeader.map((b, i) => (
                    <th
                      key={i}
                      colSpan={b.count}
                      className="border-b border-zinc-100 px-2 pb-1 text-left text-[11px] font-bold text-zinc-700"
                    >
                      {b.label}
                    </th>
                  ))}
                </tr>
                <tr>
                  {orderedVariants.map((v) => (
                    <th
                      key={v.ref}
                      className="px-2 pb-2 text-left text-[11px] font-medium text-zinc-500"
                    >
                      {channelLabel(v)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Base / size rows */}
                {!multi ? (
                  <tr>
                    <td className="sticky left-0 z-10 bg-white px-2">
                      <div className="text-sm font-medium text-zinc-800">
                        Base price
                      </div>
                      <div className="text-[10px] text-zinc-400">
                        default £{Number(product?.basePrice ?? 0).toFixed(2)}
                      </div>
                    </td>
                    {orderedVariants.map((v) => (
                      <td key={v.ref} className="px-2">
                        <Cell
                          value={itemOv[v.ref] ?? ""}
                          onChange={(val) =>
                            setItemOv({ ...itemOv, [v.ref]: val })
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
                          default £{(Number(s.price) || 0).toFixed(2)}
                        </div>
                      </td>
                      {orderedVariants.map((v) => (
                        <td key={v.ref} className="px-2">
                          <Cell
                            value={skuOv[i]?.[v.ref] ?? ""}
                            onChange={(val) =>
                              setSkuOv(
                                skuOv.map((row, idx) =>
                                  idx === i ? { ...row, [v.ref]: val } : row,
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

                {/* Modifier option rows */}
                {groups.map((g: any) => (
                  <Fragment key={`g-${g.id}`}>
                    <tr>
                      <td
                        colSpan={orderedVariants.length + 1}
                        className="sticky left-0 bg-white px-2 pt-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-400"
                      >
                        {g.name}
                      </td>
                    </tr>
                    {g.options.map((o: any) => {
                      const base = Number(o.priceAdjustment ?? 0);
                      return (
                        <tr key={o.id}>
                          <td className="sticky left-0 z-10 bg-white px-2 pl-4">
                            <div className="text-sm text-zinc-700">{o.name}</div>
                            <div className="text-[10px] text-zinc-400">
                              default +£{base.toFixed(2)}
                            </div>
                          </td>
                          {orderedVariants.map((v) => (
                            <td key={v.ref} className="px-2">
                              <Cell
                                value={optOv[o.id]?.[v.ref] ?? ""}
                                onChange={(val) =>
                                  setOptOv({
                                    ...optOv,
                                    [o.id]: { ...optOv[o.id], [v.ref]: val },
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
                ))}
              </tbody>
            </table>

            {groups.length > 0 && (
              <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
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
          {!noVariants && (
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
