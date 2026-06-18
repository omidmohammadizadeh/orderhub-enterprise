"use client";

// Phase AW-19 — Buy 1, get 1 free (BOGO) campaign form.
//
// Two pickers off the brand's published menu:
//   1. Trigger items — customer must add one of these to qualify
//   2. Reward items  — first one in the cart is added at £0 once a
//                      trigger is present
//
// We save itemIds = trigger; metadata.rewardItemIds = reward. The
// storefront surfaces both lists so the menu can highlight trigger
// items and the cart can auto-drop in the freebie.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X, Loader2, Check, ChevronDown, ChevronRight, Gift } from "lucide-react";
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

export function BogoCampaignForm({ onCancel, onSaved }: Props) {
  const selectedLocationId = useSelectedLocationStore((s) => s.selectedLocationId);

  const [name, setName] = useState("Buy 1, get 1 free");

  const [brandId, setBrandId] = useState<string | null>(null);
  const [triggerIds, setTriggerIds] = useState<Set<string>>(new Set());
  const [rewardIds, setRewardIds] = useState<Set<string>>(new Set());

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

  const save = useMutation({
    mutationFn: async () => {
      if (!brandId) throw new Error("Pick a brand");
      if (triggerIds.size === 0)
        throw new Error("Pick at least one trigger item");
      if (rewardIds.size === 0)
        throw new Error("Pick at least one reward item");
      if (channels.length === 0) throw new Error("Pick at least one channel");
      const body = {
        type: "BOGO" as const,
        brandId,
        name,
        audience,
        channels,
        itemIds: Array.from(triggerIds),
        rewardItemIds: Array.from(rewardIds),
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
    triggerIds.size > 0 &&
    rewardIds.size > 0 &&
    channels.length > 0 &&
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
            <Gift className="h-5 w-5 text-pink-600" />
            <div>
              <h2 className="text-base font-semibold text-zinc-900">
                Buy 1, get 1 free
              </h2>
              <p className="text-xs text-zinc-500">
                Customer buys a trigger item, picks a freebie at £0.
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
                  setTriggerIds(new Set());
                  setRewardIds(new Set());
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

          <Section title="Buy these items (trigger)">
            <p className="text-[11px] text-zinc-500 mb-2">
              Customer must add one of these to qualify. Trigger items get a
              "Buy 1 get 1 free" badge on the menu.
            </p>
            <ItemPicker
              categories={categories}
              loading={menuQuery.isLoading}
              selected={triggerIds}
              setSelected={setTriggerIds}
              accent="violet"
            />
          </Section>

          <Section title="Get these free (reward)">
            <p className="text-[11px] text-zinc-500 mb-2">
              The first reward in this list gets auto-added at £0 when a
              trigger lands in the cart.
            </p>
            <ItemPicker
              categories={categories}
              loading={menuQuery.isLoading}
              selected={rewardIds}
              setSelected={setRewardIds}
              accent="pink"
            />
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

function ItemPicker({
  categories,
  loading,
  selected,
  setSelected,
  accent,
}: {
  categories: MenuCategory[];
  loading: boolean;
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  accent: "violet" | "pink";
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleItem(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleCategory(cat: MenuCategory) {
    const ids = cat.items.map((i) => i.itemId);
    const allOn = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }

  function toggleExpanded(catId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  }

  const accentRowClass =
    accent === "pink"
      ? "bg-pink-50 text-pink-900"
      : "bg-violet-50 text-violet-900";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 text-zinc-400">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  if (categories.length === 0) {
    return (
      <p className="text-xs text-zinc-500">
        No published menu found for this brand.
      </p>
    );
  }

  return (
    <div className="space-y-1.5 max-h-72 overflow-y-auto">
      {categories.map((cat) => {
        const allOn =
          cat.items.length > 0 &&
          cat.items.every((i) => selected.has(i.itemId));
        const someOn =
          !allOn && cat.items.some((i) => selected.has(i.itemId));
        const isOpen = expanded.has(cat.id);
        return (
          <div key={cat.id} className="rounded-md border border-zinc-200">
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
                {cat.items.length} item{cat.items.length === 1 ? "" : "s"}
              </span>
            </div>
            {isOpen && (
              <div className="border-t border-zinc-100 px-3 py-2 space-y-1">
                {cat.items.map((moc) => {
                  const on = selected.has(moc.itemId);
                  return (
                    <label
                      key={moc.itemId}
                      className={`flex items-center gap-2 rounded px-2 py-1 cursor-pointer text-xs ${
                        on ? accentRowClass : "hover:bg-zinc-50 text-zinc-700"
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
      <p className="text-[11px] text-zinc-500 mt-2">
        Selected: {selected.size} item{selected.size === 1 ? "" : "s"}
      </p>
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
