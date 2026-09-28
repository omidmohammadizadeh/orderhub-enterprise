"use client";

// Retail — multi-buy campaign form: "3 for £2", "buy 3, cheapest free" and
// meal deals. The saving is worked out by the shared engine
// (@orderhub/shared multi-buy) at the till, in the online cart and at
// checkout, so all three agree.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Layers, Loader2, Plus, Trash2, X } from "lucide-react";
import toast from "react-hot-toast";
import { describeMultiBuy, validateMultiBuy, type MultiBuyMode } from "@orderhub/shared";
import { useCurrency } from "@/hooks/use-currency";
import { marketingClient } from "@/lib/api/marketing.client";
import { brandsClient, type Brand } from "@/lib/api/locations.client";
import { menusClient } from "@/lib/api/menus.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { ItemPicker, Section } from "./bogo-form";

interface Props {
  onCancel: () => void;
  onSaved: () => void;
}

const MODES: Array<{ id: MultiBuyMode; title: string; sub: string }> = [
  { id: "FIXED_PRICE", title: "X for a price", sub: "3 for £2 — mix and match" },
  { id: "CHEAPEST_FREE", title: "Cheapest free", sub: "Buy 3, the cheapest is free" },
  { id: "MEAL_DEAL", title: "Meal deal", sub: "Main + snack + drink for £3.50" },
];

// Deals are shelf prices, so they run where a shopper can see them.
const CHANNELS = [
  { id: "POS", label: "Till (POS)" },
  { id: "ONLINE", label: "Online shop" },
];

const DEFAULT_PRICE: Record<MultiBuyMode, string> = {
  FIXED_PRICE: "2.00",
  CHEAPEST_FREE: "2.00",
  MEAL_DEAL: "3.50",
};

interface SlotDraft {
  key: number;
  name: string;
  itemIds: Set<string>;
}

let slotKey = 0;
const newSlot = (name: string): SlotDraft => ({ key: ++slotKey, name, itemIds: new Set() });

export function MultiBuyCampaignForm({ onCancel, onSaved }: Props) {
  const { symbol } = useCurrency();
  const selectedLocationId = useSelectedLocationStore((s) => s.selectedLocationId);

  const [mode, setMode] = useState<MultiBuyMode>("FIXED_PRICE");
  const [quantity, setQuantity] = useState("3");
  const [price, setPrice] = useState("2.00");
  const [itemIds, setItemIds] = useState<Set<string>>(new Set());
  const [slots, setSlots] = useState<SlotDraft[]>(() => [newSlot("Main"), newSlot("Snack"), newSlot("Drink")]);
  const [openSlot, setOpenSlot] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);

  const [brandId, setBrandId] = useState<string | null>(null);
  const [channels, setChannels] = useState<string[]>(["POS", "ONLINE"]);
  const today = new Date().toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState("");
  const [goLive, setGoLive] = useState(true);

  const brandsQuery = useQuery({
    queryKey: ["brands", selectedLocationId ?? "tenant"],
    queryFn: () => brandsClient.list(selectedLocationId ?? undefined),
  });
  useEffect(() => {
    if (!brandId && (brandsQuery.data ?? []).length > 0) setBrandId(brandsQuery.data![0]!.id);
  }, [brandsQuery.data, brandId]);

  const menusQuery = useQuery({
    queryKey: ["marketing", "brand-menus", brandId],
    queryFn: () => menusClient.listMenus(brandId!),
    enabled: !!brandId,
  });
  const activeMenu = useMemo(() => {
    const list = menusQuery.data ?? [];
    return list.find((m) => m.isActive) ?? list[0] ?? null;
  }, [menusQuery.data]);
  const menuQuery = useQuery({
    queryKey: ["marketing", "menu", activeMenu?.id],
    queryFn: () => menusClient.getMenu(activeMenu!.id),
    enabled: !!activeMenu?.id,
  });
  const categories = menuQuery.data?.categories ?? [];

  const qty = Math.trunc(Number(quantity));
  const priceNum = Math.round(Number(price) * 100) / 100;
  const draft = {
    mode,
    quantity: mode === "MEAL_DEAL" ? 1 : qty,
    price: mode === "CHEAPEST_FREE" ? 0 : priceNum,
    itemIds: [...itemIds],
    slots: slots.map((s) => ({ name: s.name.trim() || "Choice", itemIds: [...s.itemIds] })).filter((s) => s.itemIds.length),
  };
  const problem = validateMultiBuy(draft);
  const headline = describeMultiBuy(draft, symbol);

  // Suggest a name from the deal until the operator types their own.
  useEffect(() => {
    if (!nameTouched) setName(headline);
  }, [headline, nameTouched]);

  const save = useMutation({
    mutationFn: async () => {
      if (!brandId) throw new Error("Pick a brand");
      if (problem) throw new Error(problem);
      if (!channels.length) throw new Error("Pick where the deal runs");
      if (endDate && endDate < startDate) throw new Error("The end date is before the start date");
      return marketingClient.create({
        type: "MULTI_BUY",
        brandId,
        name: name.trim() || headline,
        audience: "ALL",
        channels,
        itemIds: mode === "MEAL_DEAL" ? [] : draft.itemIds,
        multiBuy: {
          mode,
          ...(mode !== "MEAL_DEAL" ? { quantity: draft.quantity } : {}),
          ...(mode !== "CHEAPEST_FREE" ? { price: draft.price } : {}),
          ...(mode === "MEAL_DEAL" ? { slots: draft.slots } : {}),
        },
        startsAt: new Date(startDate).toISOString(),
        endsAt: endDate ? new Date(endDate + "T23:59:59").toISOString() : undefined,
        status: goLive ? "ACTIVE" : "DRAFT",
      });
    },
    onSuccess: () => {
      toast.success("Multi-buy created");
      onSaved();
    },
    onError: (err: any) => toast.error(err?.response?.data?.message ?? err?.message ?? "Failed to save"),
  });

  const setSlotItems = (key: number) => (upd: React.SetStateAction<Set<string>>) =>
    setSlots((prev) =>
      prev.map((s) => (s.key === key ? { ...s, itemIds: typeof upd === "function" ? upd(s.itemIds) : upd } : s)),
    );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-sm py-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="multibuy-title"
        className="bg-white rounded-xl shadow-2xl w-full max-w-3xl mx-4 my-4"
      >
        <header className="flex items-center justify-between border-b border-zinc-100 px-5 py-3 sticky -top-8 bg-white rounded-t-xl z-10">
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-emerald-600" aria-hidden />
            <div>
              <h2 id="multibuy-title" className="text-base font-semibold text-zinc-900">
                Multi-buy
              </h2>
              <p className="text-xs text-zinc-500">Taken off automatically at the till and online.</p>
            </div>
          </div>
          <button onClick={onCancel} aria-label="Close" className="text-zinc-400 hover:text-zinc-700 rounded p-1">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="p-5 space-y-5">
          <Section title="Type of deal">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" role="radiogroup" aria-label="Type of deal">
              {MODES.map((m) => {
                const on = mode === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => {
                      // Follow the example price for the new type until the operator sets one.
                      if (price === DEFAULT_PRICE[mode]) setPrice(DEFAULT_PRICE[m.id]);
                      setMode(m.id);
                    }}
                    className={`text-left rounded-lg border px-3 py-2.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 ${
                      on ? "border-emerald-500 bg-emerald-50" : "border-zinc-200 hover:border-zinc-300"
                    }`}
                  >
                    <p className="text-sm font-semibold text-zinc-900">{m.title}</p>
                    <p className="text-[11px] text-zinc-500">{m.sub}</p>
                  </button>
                );
              })}
            </div>
          </Section>

          <Section title="The deal">
            <div className="flex flex-wrap items-end gap-3">
              {mode !== "MEAL_DEAL" && (
                <label className="block">
                  <span className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">
                    {mode === "CHEAPEST_FREE" ? "Buy" : "Quantity"}
                  </span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={2}
                    max={50}
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    className="w-24 rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
                  />
                </label>
              )}
              {mode !== "CHEAPEST_FREE" && (
                <label className="block">
                  <span className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">
                    {mode === "MEAL_DEAL" ? "Meal deal price" : "For"} ({symbol})
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    className="w-28 rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
                  />
                </label>
              )}
              <p className="text-sm font-semibold text-emerald-700 pb-1.5" aria-live="polite">
                {headline}
              </p>
            </div>
            {problem && <p className="text-[11px] text-amber-700">{problem}</p>}
          </Section>

          <Section title="Brand">
            {brandsQuery.isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
            ) : (
              <select
                aria-label="Brand"
                className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
                value={brandId ?? ""}
                onChange={(e) => {
                  setBrandId(e.target.value || null);
                  setItemIds(new Set());
                  setSlots((prev) => prev.map((s) => ({ ...s, itemIds: new Set() })));
                }}
              >
                {(brandsQuery.data ?? []).map((b: Brand) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
          </Section>

          {mode !== "MEAL_DEAL" ? (
            <Section title="Products that count">
              <p className="text-[11px] text-zinc-500 mb-2">
                Any mix of these counts towards the deal. The dearest are grouped together first, so the shopper
                always gets the best saving.
              </p>
              <ItemPicker
                categories={categories}
                loading={menuQuery.isLoading}
                selected={itemIds}
                setSelected={setItemIds}
                accent="violet"
              />
            </Section>
          ) : (
            <Section title="Meal deal parts">
              <p className="text-[11px] text-zinc-500 mb-2">
                The shopper takes one product from each part. Two to six parts.
              </p>
              <div className="space-y-2">
                {slots.map((slot, i) => (
                  <div key={slot.key} className="rounded-md border border-zinc-200">
                    <div className="flex items-center gap-2 px-3 py-2">
                      <input
                        aria-label={`Part ${i + 1} name`}
                        value={slot.name}
                        onChange={(e) =>
                          setSlots((prev) => prev.map((s) => (s.key === slot.key ? { ...s, name: e.target.value } : s)))
                        }
                        className="flex-1 min-w-0 rounded-md border border-zinc-200 px-2 py-1 text-sm focus:border-zinc-900 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setOpenSlot(openSlot === slot.key ? null : slot.key)}
                        aria-expanded={openSlot === slot.key}
                        className="rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 whitespace-nowrap"
                      >
                        {slot.itemIds.size} product{slot.itemIds.size === 1 ? "" : "s"}
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${slot.name || "part"}`}
                        disabled={slots.length <= 2}
                        onClick={() => setSlots((prev) => prev.filter((s) => s.key !== slot.key))}
                        className="rounded p-1 text-zinc-400 hover:text-red-600 disabled:opacity-30"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    {openSlot === slot.key && (
                      <div className="border-t border-zinc-100 p-2">
                        <ItemPicker
                          categories={categories}
                          loading={menuQuery.isLoading}
                          selected={slot.itemIds}
                          setSelected={setSlotItems(slot.key)}
                          accent="violet"
                        />
                      </div>
                    )}
                  </div>
                ))}
                {slots.length < 6 && (
                  <button
                    type="button"
                    onClick={() => setSlots((prev) => [...prev, newSlot(`Part ${prev.length + 1}`)])}
                    className="inline-flex items-center gap-1 rounded-md border border-dashed border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add a part
                  </button>
                )}
              </div>
            </Section>
          )}

          <Section title="Campaign name">
            <input
              aria-label="Campaign name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
            />
            <p className="text-[11px] text-zinc-500">Shown on receipts and in the online basket.</p>
          </Section>

          <Section title="Where it runs">
            <div className="flex flex-wrap gap-2">
              {CHANNELS.map((c) => {
                const on = channels.includes(c.id);
                return (
                  <label
                    key={c.id}
                    className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs cursor-pointer ${
                      on ? "border-emerald-300 bg-emerald-50" : "border-zinc-200 hover:border-zinc-300"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setChannels((prev) => (prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id]))
                      }
                    />
                    {c.label}
                  </label>
                );
              })}
            </div>
          </Section>

          <Section title="Dates">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Start</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">
                  End (optional)
                </span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
                />
              </label>
            </div>
            <label className="flex items-center gap-2 cursor-pointer pt-1">
              <input type="checkbox" checked={goLive} onChange={(e) => setGoLive(e.target.checked)} />
              <span className="text-sm text-zinc-900">Start right after saving</span>
            </label>
          </Section>
        </div>

        <footer className="border-t border-zinc-100 px-5 py-3 flex items-center justify-end gap-2 sticky -bottom-8 bg-white rounded-b-xl z-10">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={!brandId || !!problem || !channels.length || save.isPending}
            className="rounded-md bg-zinc-900 text-white px-3 py-1.5 text-xs font-semibold hover:bg-zinc-800 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Create multi-buy
          </button>
        </footer>
      </div>
    </div>
  );
}
