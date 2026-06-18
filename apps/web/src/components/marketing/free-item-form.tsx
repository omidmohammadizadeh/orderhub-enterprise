"use client";

// Phase AW-19 — Free item with purchase.
//
// Operator picks:
//   - the pool of items the customer can claim (1 → auto-added,
//     more → storefront shows a picker chip strip)
//   - a minimum spend threshold (the gift unlocks when eligible
//     subtotal clears this)
//   - categories whose items DON'T count toward the threshold
//     (e.g. exclude Meal Deals so they don't double-dip)

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X, Loader2, Check, ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import toast from "react-hot-toast";
import {
  marketingClient,
  type CampaignAudience,
} from "@/lib/api/marketing.client";
import { brandsClient, type Brand } from "@/lib/api/locations.client";
import { menusClient, type MenuCategory } from "@/lib/api/menus.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";

interface Props {
  onCancel: () => void;
  onSaved: () => void;
}

const MIN_ORDER_CHIPS = [10, 15, 20, 25, 30, 40, 50];

const CHANNELS: Array<{ id: string; label: string; wired: boolean }> = [
  { id: "ONLINE", label: "Online ordering", wired: true },
  { id: "POS", label: "POS", wired: true },
  { id: "JUST_EAT", label: "Just Eat", wired: false },
  { id: "UBER_EATS", label: "Uber Eats", wired: false },
  { id: "DELIVEROO", label: "Deliveroo", wired: false },
  { id: "WHATSAPP", label: "WhatsApp", wired: false },
  { id: "HUBRISE", label: "HubRise", wired: false },
];

const AUDIENCES: Array<{ id: CampaignAudience; label: string; sub: string }> = [
  { id: "ALL", label: "All customers", sub: "Recommended" },
  { id: "NEW", label: "New customers only", sub: "Haven't ordered before" },
  { id: "RETURNING", label: "Returning", sub: "Ordered in the last 90 days" },
  { id: "LAPSED", label: "Lapsed", sub: "Last order 45+ days ago" },
];

export function FreeItemCampaignForm({ onCancel, onSaved }: Props) {
  const selectedLocationId = useSelectedLocationStore((s) => s.selectedLocationId);

  const [name, setName] = useState("Free item with purchase");

  const [brandId, setBrandId] = useState<string | null>(null);
  const [freeItemIds, setFreeItemIds] = useState<Set<string>>(new Set());
  const [excludedCategoryIds, setExcludedCategoryIds] = useState<Set<string>>(
    new Set(),
  );

  const [minOrder, setMinOrder] = useState<number>(20);
  const [minOrderCustom, setMinOrderCustom] = useState(false);

  const [channels, setChannels] = useState<string[]>(["ONLINE"]);
  const [audience, setAudience] = useState<CampaignAudience>("ALL");

  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(in30);
  const [runUntilCancelled, setRunUntilCancelled] = useState(false);

  const [goLive, setGoLive] = useState(true);

  const brandsQuery = useQuery({
    queryKey: ["brands", selectedLocationId ?? "tenant"],
    queryFn: () => brandsClient.list(selectedLocationId ?? undefined),
  });

  useEffect(() => {
    if (!brandId && (brandsQuery.data ?? []).length > 0) {
      setBrandId(brandsQuery.data![0]!.id);
    }
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

  function toggleItem(id: string) {
    setFreeItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleCategoryItems(cat: MenuCategory) {
    const ids = cat.items.map((i) => i.itemId);
    const allOn = ids.every((id) => freeItemIds.has(id));
    setFreeItemIds((prev) => {
      const next = new Set(prev);
      if (allOn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }
  const [expandedFree, setExpandedFree] = useState<Set<string>>(new Set());
  function toggleExpandedFree(id: string) {
    setExpandedFree((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleExclusion(id: string) {
    setExcludedCategoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!brandId) throw new Error("Pick a brand");
      if (freeItemIds.size === 0)
        throw new Error("Pick at least one free item");
      if (channels.length === 0) throw new Error("Pick at least one channel");
      if (!minOrder || minOrder <= 0)
        throw new Error("Set a minimum spend amount");
      const body = {
        type: "FREE_ITEM" as const,
        brandId,
        name,
        audience,
        channels,
        itemIds: Array.from(freeItemIds),
        excludedCategoryIds: Array.from(excludedCategoryIds),
        minOrder,
        startsAt: new Date(startDate).toISOString(),
        endsAt: runUntilCancelled
          ? undefined
          : new Date(endDate + "T23:59:59").toISOString(),
        status: (goLive ? "ACTIVE" : "DRAFT") as "ACTIVE" | "DRAFT",
      };
      return marketingClient.create(body);
    },
    onSuccess: () => {
      toast.success("Campaign created");
      onSaved();
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.message ?? err?.message ?? "Failed to save",
      ),
  });

  const canSave =
    !!brandId &&
    freeItemIds.size > 0 &&
    channels.length > 0 &&
    minOrder > 0 &&
    !save.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-sm py-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl mx-4 my-4">
        <header className="flex items-center justify-between border-b border-zinc-100 px-5 py-3 sticky top-0 bg-white rounded-t-xl">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-amber-500" />
            <div>
              <h2 className="text-base font-semibold text-zinc-900">
                Free item with purchase
              </h2>
              <p className="text-xs text-zinc-500">
                e.g. "Spend £20, get a free 10″ Margherita."
              </p>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="text-zinc-400 hover:text-zinc-700 rounded p-1"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="p-5 space-y-5">
          <Section title="Campaign name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input"
            />
          </Section>

          <Section title="Brand">
            {brandsQuery.isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
            ) : (
              <select
                className="input"
                value={brandId ?? ""}
                onChange={(e) => {
                  setBrandId(e.target.value || null);
                  setFreeItemIds(new Set());
                  setExcludedCategoryIds(new Set());
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

          <Section title="Minimum spend">
            <p className="text-[11px] text-zinc-500 mb-2">
              The free item unlocks when the eligible cart subtotal hits
              this amount. Excluded categories below don't count toward it.
            </p>
            <div className="flex flex-wrap gap-2">
              {MIN_ORDER_CHIPS.map((v) => (
                <Chip
                  key={v}
                  active={!minOrderCustom && minOrder === v}
                  onClick={() => {
                    setMinOrder(v);
                    setMinOrderCustom(false);
                  }}
                >
                  £{v}
                </Chip>
              ))}
              <Chip
                active={minOrderCustom}
                onClick={() => setMinOrderCustom(true)}
              >
                Custom
              </Chip>
              {minOrderCustom && (
                <input
                  type="number"
                  min={1}
                  value={minOrder}
                  onChange={(e) => setMinOrder(Number(e.target.value) || 0)}
                  className="w-24 rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
                />
              )}
            </div>
          </Section>

          <Section title="Free items">
            <p className="text-[11px] text-zinc-500 mb-2">
              Pick one or more items. If you pick more than one, the
              customer picks which one to claim. Tick whole categories
              to include everything in them.
            </p>
            {menuQuery.isLoading ? (
              <div className="flex items-center justify-center py-6 text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : categories.length === 0 ? (
              <p className="text-xs text-zinc-500">
                No published menu found for this brand.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {categories.map((cat) => {
                  const allOn =
                    cat.items.length > 0 &&
                    cat.items.every((i) => freeItemIds.has(i.itemId));
                  const someOn =
                    !allOn &&
                    cat.items.some((i) => freeItemIds.has(i.itemId));
                  const isOpen = expandedFree.has(cat.id);
                  return (
                    <div
                      key={cat.id}
                      className="rounded-md border border-zinc-200"
                    >
                      <div className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-50">
                        <button
                          type="button"
                          onClick={() => toggleExpandedFree(cat.id)}
                          className="text-zinc-400 hover:text-zinc-700"
                        >
                          {isOpen ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>
                        <input
                          type="checkbox"
                          checked={allOn}
                          ref={(el) => {
                            if (el) el.indeterminate = someOn;
                          }}
                          onChange={() => toggleCategoryItems(cat)}
                        />
                        <span className="text-sm font-medium text-zinc-900">
                          {cat.name}
                        </span>
                        <span className="text-[11px] text-zinc-500 ml-auto">
                          {cat.items.length} item
                          {cat.items.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      {isOpen && (
                        <div className="border-t border-zinc-100 px-3 py-2 space-y-1">
                          {cat.items.map((moc) => {
                            const on = freeItemIds.has(moc.itemId);
                            return (
                              <label
                                key={moc.itemId}
                                className={`flex items-center gap-2 rounded px-2 py-1 cursor-pointer text-xs ${
                                  on
                                    ? "bg-amber-50 text-amber-900"
                                    : "hover:bg-zinc-50 text-zinc-700"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={on}
                                  onChange={() => toggleItem(moc.itemId)}
                                />
                                <span className="flex-1">{moc.item.name}</span>
                                <span className="text-zinc-500">
                                  £{Number(moc.item.basePrice).toFixed(2)}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] text-zinc-500 mt-2">
              Selected: {freeItemIds.size} item
              {freeItemIds.size === 1 ? "" : "s"}
            </p>
          </Section>

          <Section title="Excluded categories (optional)">
            <p className="text-[11px] text-zinc-500 mb-2">
              Items in these categories don't count toward the spend
              threshold. Useful for keeping promos like Meal Deals from
              double-dipping.
            </p>
            {categories.length === 0 ? (
              <p className="text-xs text-zinc-500">
                No categories to exclude.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {categories.map((cat) => {
                  const on = excludedCategoryIds.has(cat.id);
                  return (
                    <label
                      key={cat.id}
                      className={`flex items-center gap-2 rounded-md border px-3 py-1.5 cursor-pointer text-xs ${
                        on
                          ? "border-rose-300 bg-rose-50 text-rose-900"
                          : "border-zinc-200 hover:border-zinc-300"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleExclusion(cat.id)}
                      />
                      <span>{cat.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </Section>

          <Section title="Channels">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {CHANNELS.map((c) => {
                const on = channels.includes(c.id);
                return (
                  <label
                    key={c.id}
                    className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs cursor-pointer ${
                      on
                        ? "border-orange-300 bg-orange-50"
                        : "border-zinc-200 hover:border-zinc-300"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setChannels((prev) =>
                          prev.includes(c.id)
                            ? prev.filter((id) => id !== c.id)
                            : [...prev, c.id],
                        )
                      }
                    />
                    <span>{c.label}</span>
                    {!c.wired && (
                      <span className="text-[10px] text-amber-700 ml-auto">
                        soon
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </Section>

          <Section title="Audience">
            <div className="space-y-1.5">
              {AUDIENCES.map((a) => {
                const on = audience === a.id;
                return (
                  <label
                    key={a.id}
                    className={`flex items-center justify-between rounded-md border px-3 py-2 cursor-pointer ${
                      on
                        ? "border-zinc-900 bg-zinc-50"
                        : "border-zinc-200 hover:border-zinc-300"
                    }`}
                  >
                    <div>
                      <p className="text-sm font-medium text-zinc-900">
                        {a.label}
                      </p>
                      <p className="text-[11px] text-zinc-500">{a.sub}</p>
                    </div>
                    <input
                      type="radio"
                      checked={on}
                      onChange={() => setAudience(a.id)}
                    />
                  </label>
                );
              })}
            </div>
          </Section>

          <Section title="Duration">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">
                  Start
                </label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="input"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">
                  End
                </label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  disabled={runUntilCancelled}
                  className="input disabled:bg-zinc-50 disabled:text-zinc-400"
                />
              </div>
            </div>
            <label className="mt-3 flex items-center gap-2 cursor-pointer rounded-md border border-zinc-200 px-3 py-2 hover:border-zinc-300">
              <input
                type="checkbox"
                checked={runUntilCancelled}
                onChange={(e) => setRunUntilCancelled(e.target.checked)}
              />
              <div>
                <p className="text-sm text-zinc-900">Run until I cancel</p>
                <p className="text-[11px] text-zinc-500">
                  Campaign stays active with no end date.
                </p>
              </div>
            </label>
          </Section>

          <Section title="Status">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={goLive}
                onChange={(e) => setGoLive(e.target.checked)}
              />
              <span className="text-sm text-zinc-900">
                Start the campaign right after saving
              </span>
            </label>
          </Section>
        </div>

        <footer className="border-t border-zinc-100 px-5 py-3 flex items-center justify-end gap-2 sticky bottom-0 bg-white rounded-b-xl">
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
            disabled={!canSave}
            className="rounded-md bg-zinc-900 text-white px-3 py-1.5 text-xs font-semibold hover:bg-zinc-800 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {save.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Create campaign
          </button>
        </footer>

        <style jsx>{`
          .input {
            width: 100%;
            border-radius: 0.375rem;
            border: 1px solid rgb(228 228 231);
            padding: 0.375rem 0.5rem;
            font-size: 0.875rem;
          }
          .input:focus {
            outline: none;
            border-color: rgb(24 24 27);
          }
        `}</style>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-zinc-200 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-700 mb-3">
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
        active
          ? "border-zinc-900 bg-zinc-900 text-white"
          : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}
