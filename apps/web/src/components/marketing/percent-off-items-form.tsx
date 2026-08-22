"use client";

// Phase AW-19 — Percent-off-items campaign form.
//
// Differs from the storewide percentage form in two ways:
//   1. Single brand (the item picker needs to know whose menu to load)
//   2. Item / category picker: ticking a category checks all its items.
//      We always save a flat itemIds[] — categories are a UI grouping
//      that expands at save time, so adding new items to a category
//      later won't retroactively join the promo (operator re-saves
//      to opt in). Storefront paints strikethrough + percent badge
//      based on this itemIds list.

import { useEffect, useMemo, useState } from "react";
import { useCurrency } from "@/hooks/use-currency";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X, Loader2, Check, ChevronDown, ChevronRight } from "lucide-react";
import toast from "react-hot-toast";
import {
  marketingClient,
  type CampaignAudience,
} from "@/lib/api/marketing.client";
import { brandsClient, type Brand } from "@/lib/api/locations.client";
import { menusClient } from "@/lib/api/menus.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";

interface Props {
  onCancel: () => void;
  onSaved: () => void;
}

const PERCENT_CHIPS = [10, 15, 20, 25, 30, 50];

const CHANNELS: Array<{ id: string; label: string; wired: boolean }> = [
  { id: "ONLINE", label: "Online ordering", wired: true },
  { id: "POS", label: "POS", wired: true },
  { id: "JUST_EAT", label: "Just Eat", wired: false },
  { id: "UBER_EATS", label: "Uber Eats", wired: true },
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

export function PercentOffItemsCampaignForm({ onCancel, onSaved }: Props) {
  // Prices follow the selected location's currency, not a hardcoded pound.
  const { money, symbol } = useCurrency();
  const selectedLocationId = useSelectedLocationStore((s) => s.selectedLocationId);

  const [name, setName] = useState("Per cent off items");
  const [percent, setPercent] = useState(20);
  const [percentCustom, setPercentCustom] = useState(false);

  const [brandId, setBrandId] = useState<string | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

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

  // Default to the first brand the operator owns.
  useEffect(() => {
    if (!brandId && (brandsQuery.data ?? []).length > 0) {
      setBrandId(brandsQuery.data![0]!.id);
    }
  }, [brandsQuery.data, brandId]);

  // List menus for the brand, then pull each menu's full category +
  // item tree. We pick the first ACTIVE menu — operators rarely have
  // more than one published menu per brand on the same channel.
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

  function toggleItem(itemId: string) {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function toggleCategory(cat: { id: string; items: Array<{ itemId: string }> }) {
    const ids = cat.items.map((i) => i.itemId);
    const allOn = ids.every((id) => selectedItemIds.has(id));
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (allOn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }

  function toggleExpanded(catId: string) {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!brandId) throw new Error("Pick a brand");
      if (selectedItemIds.size === 0)
        throw new Error("Pick at least one item or category");
      if (channels.length === 0) throw new Error("Pick at least one channel");
      const body = {
        type: "PERCENT_OFF_ITEMS" as const,
        brandId,
        name,
        audience,
        channels,
        percentageOff: percent,
        itemIds: Array.from(selectedItemIds),
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
    selectedItemIds.size > 0 &&
    channels.length > 0 &&
    percent > 0 &&
    percent <= 100 &&
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
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              Per cent off items
            </h2>
            <p className="text-xs text-zinc-500">
              Apply a percentage off selected items or categories.
            </p>
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

          <Section title="Promotion">
            <Label>Percentage</Label>
            <div className="flex flex-wrap gap-2">
              {PERCENT_CHIPS.map((p) => (
                <Chip
                  key={p}
                  active={!percentCustom && percent === p}
                  onClick={() => {
                    setPercent(p);
                    setPercentCustom(false);
                  }}
                >
                  {p}%
                </Chip>
              ))}
              <Chip
                active={percentCustom}
                onClick={() => setPercentCustom(true)}
              >
                Custom
              </Chip>
              {percentCustom && (
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={percent}
                  onChange={(e) => setPercent(Number(e.target.value) || 0)}
                  className="w-24 rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
                />
              )}
            </div>
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
                  setSelectedItemIds(new Set());
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

          <Section title="Items and categories">
            <p className="text-[11px] text-zinc-500 mb-2">
              Tick whole categories or pick individual items. The percent off
              applies on the storefront with a strikethrough price.
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
              <div className="space-y-1.5 max-h-96 overflow-y-auto">
                {categories.map((cat) => {
                  const allOn =
                    cat.items.length > 0 &&
                    cat.items.every((i) => selectedItemIds.has(i.itemId));
                  const someOn =
                    !allOn && cat.items.some((i) => selectedItemIds.has(i.itemId));
                  const isOpen = expandedCategories.has(cat.id);
                  return (
                    <div
                      key={cat.id}
                      className="rounded-md border border-zinc-200"
                    >
                      <div className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-50">
                        <button
                          type="button"
                          onClick={() => toggleExpanded(cat.id)}
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
                          onChange={() => toggleCategory(cat)}
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
                            const on = selectedItemIds.has(moc.itemId);
                            return (
                              <label
                                key={moc.itemId}
                                className={`flex items-center gap-2 rounded px-2 py-1 cursor-pointer text-xs ${
                                  on
                                    ? "bg-violet-50 text-violet-900"
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
                                  {money(Number(moc.item.basePrice))}
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
              Selected: {selectedItemIds.size} item
              {selectedItemIds.size === 1 ? "" : "s"}
            </p>
          </Section>

          <Section title="Channels">
            <p className="text-[11px] text-zinc-500 mb-2">
              Online ordering applies the offer automatically. POS lets the
              operator pick it at the till.
            </p>
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
                <Label>Start</Label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="input"
                />
              </div>
              <div>
                <Label>End</Label>
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
            <p className="text-[11px] text-zinc-500 mt-1">
              Unchecked = saved as a draft. Storefront only paints discounts
              for ACTIVE campaigns.
            </p>
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

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">
      {children}
    </label>
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
