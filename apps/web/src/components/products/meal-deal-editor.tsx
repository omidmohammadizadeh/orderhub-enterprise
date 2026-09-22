"use client";

// The section editor for a meal deal: what the customer picks, from which
// products, and what each pick costs on top of the deal price.
//
// These sections are what Deliveroo publishes as a bundle, so the editor
// shows Deliveroo's own bundle rules as the operator builds — a deal that
// breaks one is left off the Deliveroo menu at publish time, and it is far
// kinder to say why here than in a publish warning later. The rules use the
// products' base prices; the publish check (which sees channel prices) is
// the final word.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Plus, Trash2, X } from "lucide-react";
import { useCurrency } from "@/hooks/use-currency";
import { mealDealsClient, productsClient, type MealDeal } from "@/lib/api/catalog.client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { SearchableSelect } from "@/components/ui/searchable-select";

type Option = { menuItemId: string; priceOverride?: number };
type Section = { name: string; picks: number; options: Option[] };

const toPence = (n: unknown) => Math.round((Number(n) || 0) * 100);

export function MealDealEditor({
  deal,
  onClose,
  invalidateKey,
  locationId,
}: {
  deal: MealDeal;
  onClose: () => void;
  invalidateKey: unknown[];
  /** Stamps a product created from here onto the same shop, like the Products tab. */
  locationId?: string | null;
}) {
  const { money, symbol } = useCurrency();
  const qc = useQueryClient();

  const [name, setName] = useState(deal.name);
  const [price, setPrice] = useState(deal.price != null ? String(Number(deal.price)) : "");
  const [sections, setSections] = useState<Section[]>(() =>
    (deal.sections ?? []).map((s) => ({
      name: s.name ?? "",
      // Deliveroo makes the customer pick the maximum, so one number is the
      // honest control. Older rows may carry min≠max; max is what counts.
      picks: Math.max(1, Number(s.maxChoices ?? s.minChoices ?? 1) || 1),
      options: (s.options ?? []).map((o) => ({
        menuItemId: o.menuItemId,
        ...(o.priceOverride != null ? { priceOverride: Number(o.priceOverride) } : {}),
      })),
    })),
  );

  const productsKey = ["catalog", "products", deal.brandId];
  const { data: products = [] } = useQuery({
    queryKey: productsKey,
    queryFn: () => productsClient.list(deal.brandId),
  });

  // Making a product without leaving the deal: the section is usually where
  // an operator notices the drink or side doesn't exist yet. It is created
  // on the DEAL's brand, so it can be used here at all.
  const [creatingIn, setCreatingIn] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const createProduct = useMutation({
    mutationFn: async (sectionIndex: number) => {
      const created = await productsClient.create(deal.brandId, {
        name: newName.trim(),
        basePrice: Number(newPrice) || 0,
        ...(locationId ? { locationId } : {}),
      });
      return { created, sectionIndex };
    },
    onSuccess: ({ created, sectionIndex }) => {
      qc.invalidateQueries({ queryKey: productsKey });
      // Put it straight into the section that asked for it.
      setSections((all) =>
        all.map((s, j) =>
          j === sectionIndex ? { ...s, options: [...s.options, { menuItemId: created.id }] } : s,
        ),
      );
      setCreatingIn(null);
      setNewName("");
      setNewPrice("");
    },
  });
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const priceOf = (id: string) => toPence(productById.get(id)?.basePrice);

  const save = useMutation({
    mutationFn: () =>
      mealDealsClient.update(deal.id, {
        name: name.trim(),
        price: price === "" ? null : Number(price),
        sections: sections.map((s) => ({
          name: s.name.trim() || "Choose",
          minChoices: s.picks,
          maxChoices: s.picks,
          options: s.options,
        })),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: invalidateKey });
      onClose();
    },
  });

  const patchSection = (i: number, patch: Partial<Section>) =>
    setSections((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const patchOption = (i: number, k: number, patch: Partial<Option>) =>
    patchSection(i, {
      options: sections[i]!.options.map((o, j) => (j === k ? { ...o, ...patch } : o)),
    });

  // ── Deliveroo's bundle rules, on the prices we can see here ──────────
  const sectionIssues = sections.map((s) => {
    const issues: string[] = [];
    if (s.options.length === 0) return ["Add at least one product."];
    const included = s.options.filter((o) => !o.priceOverride).length;
    if (included < s.picks) {
      issues.push(
        `Customers pick ${s.picks}, so at least ${s.picks} product${s.picks === 1 ? " needs" : "s need"} to be included at no extra cost.`,
      );
    }
    const cheapest = Math.min(...s.options.map((o) => priceOf(o.menuItemId)));
    for (const o of s.options) {
      const extra = toPence(o.priceOverride);
      const headroom = priceOf(o.menuItemId) - cheapest;
      if (extra > headroom) {
        issues.push(
          `${productById.get(o.menuItemId)?.name ?? "A product"} can be at most ${money(headroom / 100)} extra (its price over the cheapest in this section).`,
        );
      }
    }
    return issues;
  });
  const separately = sections.reduce((sum, s) => {
    const free = s.options
      .filter((o) => !o.priceOverride)
      .map((o) => priceOf(o.menuItemId))
      .sort((a, z) => a - z)
      .slice(0, s.picks);
    return sum + free.reduce((n, p) => n + p, 0);
  }, 0);
  const dealIssues: string[] = [];
  // Only comparable once every section can be filled at no extra cost —
  // before that, "separately" leaves out the sections still being built and
  // would quote a total the customer could never actually buy.
  const sectionsComplete = sectionIssues.every((s) => s.length === 0);
  if (price === "") dealIssues.push("Set a price — a deal without one can't go on Deliveroo.");
  else if (sections.length && sectionsComplete && toPence(price) > separately) {
    dealIssues.push(
      `The deal costs more than the same items bought separately (${money(separately / 100)}). Deliveroo won't list it.`,
    );
  }
  if (sections.length === 0) dealIssues.push("Add a section, e.g. \"Choose your burger\".");

  const productOptions = products.map((p) => ({
    value: p.id,
    label: p.name,
    hint: money(Number(p.basePrice)),
  }));

  return (
    <Card className="p-4 border-orange-200 bg-orange-50/60 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-[1fr_9rem]">
          <label className="space-y-1">
            <span className="text-xs font-medium text-zinc-600">Deal name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9 bg-white text-sm" />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium text-zinc-600">Price ({symbol.trim()})</span>
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="h-9 bg-white text-sm tabular-nums"
            />
          </label>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close without saving"
          className="rounded-md p-1.5 text-zinc-500 hover:bg-orange-100 hover:text-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <ol className="space-y-3">
        {sections.map((s, i) => {
          const taken = new Set(s.options.map((o) => o.menuItemId));
          return (
            <li key={i} className="rounded-lg border border-zinc-200 bg-white p-3 space-y-2.5">
              <div className="flex flex-wrap items-end gap-2">
                {/* Full width on a phone so the name is readable; picks and
                    the bin drop to the line below. */}
                <label className="min-w-0 basis-full space-y-1 sm:basis-auto sm:flex-1">
                  <span className="text-xs font-medium text-zinc-600">Section {i + 1}</span>
                  <Input
                    value={s.name}
                    placeholder="e.g. Choose your burger"
                    onChange={(e) => patchSection(i, { name: e.target.value })}
                    className="h-9 text-sm"
                  />
                </label>
                <label className="w-28 space-y-1">
                  <span className="text-xs font-medium text-zinc-600">Customer picks</span>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={s.picks}
                    onChange={(e) =>
                      patchSection(i, { picks: Math.min(10, Math.max(1, Number(e.target.value) || 1)) })
                    }
                    className="h-9 text-sm tabular-nums"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setSections((all) => all.filter((_, j) => j !== i))}
                  aria-label={`Remove section ${s.name || i + 1}`}
                  className="mb-0.5 rounded-md p-2 text-zinc-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-500"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              {s.options.length > 0 && (
                <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-100">
                  {s.options.map((o, k) => {
                    const p = productById.get(o.menuItemId);
                    return (
                      <li
                        key={o.menuItemId}
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5"
                      >
                        <span className="min-w-0 basis-full truncate text-sm text-zinc-800 sm:basis-auto sm:flex-1">
                          {p?.name ?? "Product no longer exists"}
                          {p && (
                            <span className="ml-1.5 text-xs text-zinc-400 tabular-nums">
                              {money(Number(p.basePrice))} on its own
                            </span>
                          )}
                        </span>
                        <label className="ml-auto flex items-center gap-1.5 text-xs text-zinc-500 sm:ml-0">
                          <span>Extra</span>
                          <Input
                            type="number"
                            inputMode="decimal"
                            step="0.01"
                            min="0"
                            placeholder="Included"
                            aria-label={`Extra charge for ${p?.name ?? "this product"} in this deal`}
                            value={o.priceOverride ?? ""}
                            onChange={(e) =>
                              patchOption(i, k, {
                                priceOverride:
                                  e.target.value === "" || Number(e.target.value) === 0
                                    ? undefined
                                    : Number(e.target.value),
                              })
                            }
                            className="h-8 w-24 text-sm tabular-nums"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            patchSection(i, { options: s.options.filter((_, j) => j !== k) })
                          }
                          aria-label={`Remove ${p?.name ?? "product"} from ${s.name || "this section"}`}
                          className="rounded p-1 text-zinc-400 hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-500"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <SearchableSelect
                  options={productOptions.filter((p) => !taken.has(p.value))}
                  value={undefined}
                  allowAll={false}
                  placeholder="Add a product…"
                  searchPlaceholder="Search products…"
                  onChange={(id) =>
                    id && patchSection(i, { options: [...s.options, { menuItemId: id }] })
                  }
                />
                {creatingIn !== i && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-9 bg-white"
                    onClick={() => {
                      setCreatingIn(i);
                      setNewName("");
                      setNewPrice("");
                    }}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    New product
                  </Button>
                )}
              </div>

              {creatingIn === i && (
                <div className="rounded-md border border-zinc-200 bg-zinc-50 p-2.5 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      autoFocus
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="Product name"
                      aria-label="New product name"
                      className="h-8 min-w-40 flex-1 bg-white text-sm"
                    />
                    <Input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0"
                      value={newPrice}
                      onChange={(e) => setNewPrice(e.target.value)}
                      placeholder={`Price (${symbol.trim()})`}
                      aria-label="New product price"
                      className="h-8 w-28 bg-white text-sm tabular-nums"
                    />
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 bg-orange-500 text-white hover:bg-orange-600"
                      disabled={!newName.trim() || createProduct.isPending}
                      onClick={() => createProduct.mutate(i)}
                    >
                      {createProduct.isPending ? "Adding…" : "Add"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 bg-white"
                      onClick={() => setCreatingIn(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                  <p className="text-[11px] text-zinc-500">
                    Creates a {deal.brand?.name ?? "brand"} product. Add it to the menu you
                    publish too, or Deliveroo won&rsquo;t see it and it&rsquo;s dropped from
                    this section.
                  </p>
                  {createProduct.isError && (
                    <p role="alert" className="text-[11px] text-red-600">
                      Couldn&rsquo;t create that product. Please try again.
                    </p>
                  )}
                </div>
              )}

              {sectionIssues[i]!.length > 0 && (
                <ul className="space-y-1">
                  {sectionIssues[i]!.map((msg) => (
                    <li key={msg} className="flex gap-1.5 text-xs text-amber-700">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                      {msg}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>

      <Button
        type="button"
        size="sm"
        variant="outline"
        className="bg-white"
        onClick={() => setSections((all) => [...all, { name: "", picks: 1, options: [] }])}
      >
        <Plus className="mr-1.5 h-4 w-4" />
        Add section
      </Button>

      {dealIssues.length > 0 && (
        <ul className="space-y-1 rounded-md bg-amber-50 px-3 py-2">
          {dealIssues.map((msg) => (
            <li key={msg} className="flex gap-1.5 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {msg}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-zinc-500">
        Published to Deliveroo as a bundle in a “Meal Deals” category. Warnings follow Deliveroo’s
        bundle rules — a deal that breaks one stays off Deliveroo until it’s fixed.
      </p>

      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" className="bg-white" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => save.mutate()}
          disabled={!name.trim() || save.isPending}
          className="bg-orange-500 text-white hover:bg-orange-600"
        >
          {save.isPending ? "Saving…" : "Save deal"}
        </Button>
      </div>
      {save.isError && (
        <p role="alert" className="text-xs text-red-600">
          Couldn&rsquo;t save the deal. Please try again.
        </p>
      )}
    </Card>
  );
}
