"use client";

// Loyalty card settings, per location.
//
// It sits in Marketing because that is where an operator goes to give money
// away, but it is not a campaign and is kept visibly apart from them:
// campaigns are advertised on the storefront and pushed to marketplaces, and
// a stamp card is private to the customer holding it.
//
// Per LOCATION, deliberately — the shop giving the food away is the shop that
// pays for it, and a group running six sites will not want one rule across
// all of them.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Heart, Loader2, Check, X, Search } from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { useCurrency } from "@/hooks/use-currency";
import { brandsClient } from "@/lib/api/locations.client";

interface Card {
  isActive: boolean;
  stampsRequired: number;
  minimumSpend: number | string | null;
  rewardItemId: string | null;
  rewardLabel: string;
  rewardExpiryDays: number | null;
}

export function LoyaltyCardPanel({
  brandId,
  onClose,
}: {
  brandId?: string | null;
  onClose?: () => void;
}) {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const { symbol } = useCurrency();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<Card>({
    queryKey: ["loyalty-card-config", locationId],
    enabled: !!locationId,
    queryFn: () =>
      apiClient.get(`/v1/loyalty/cards/${locationId}`).then((r) => r.data),
  });

  // The reward comes from the PUBLISHED menu, the same source Top Sellers
  // uses — not the product catalog. The catalog holds everything a tenant has
  // ever created, including items on no menu at all, and offering one of those
  // as a reward is offering something the customer cannot see and the kitchen
  // may not make.
  const { data: brands = [] } = useQuery({
    queryKey: ["brands", locationId],
    queryFn: () => brandsClient.list(locationId ?? undefined),
    enabled: !!locationId,
  });
  const [pickedBrand, setPickedBrand] = useState<string | null>(brandId ?? null);
  const activeBrand = brands.find((b: any) => b.id === pickedBrand) ?? brands[0];

  const { data: storefront } = useQuery({
    queryKey: ["loyalty-reward-menu", locationId, activeBrand?.id],
    enabled: !!locationId && !!activeBrand?.id,
    queryFn: () =>
      apiClient
        .get(
          `/v1/ordering/store/${encodeURIComponent(String(locationId))}` +
            `?brand=${encodeURIComponent(activeBrand!.id)}`,
        )
        .then((r) => r.data as any),
  });

  const items = useMemo(() => {
    const out: Array<{ id: string; name: string; price: number; imageUrl: string | null; category: string }> = [];
    for (const cat of storefront?.menu?.categories ?? []) {
      for (const link of cat.items ?? []) {
        const it = link?.item;
        if (!it?.id) continue;
        out.push({
          id: it.id,
          name: it.name,
          price: Number(it.basePrice ?? 0),
          imageUrl: it.imageUrl ?? null,
          category: cat.name ?? "",
        });
      }
    }
    return out;
  }, [storefront]);

  const [itemSearch, setItemSearch] = useState("");
  const shown = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q),
    );
  }, [items, itemSearch]);

  const [form, setForm] = useState<Card | null>(null);
  useEffect(() => {
    if (data && !form) setForm({ ...data, minimumSpend: data.minimumSpend ?? null });
  }, [data, form]);

  const save = useMutation({
    mutationFn: (body: Card) =>
      apiClient.put(`/v1/loyalty/cards/${locationId}`, body).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["loyalty-card-config", locationId] });
      // Close on save so the operator lands back on the campaigns list, the
      // same way the campaign form behaves.
      onClose?.();
    },
  });

  if (!locationId) {
    return (
      <Shell>
        <p className="text-sm text-zinc-500">
          Pick a location — a loyalty card belongs to one shop, not the whole
          group.
        </p>
      </Shell>
    );
  }
  if (isLoading || !form) {
    return (
      <Shell>
        <Loader2 className="h-5 w-5 animate-spin text-zinc-300" />
      </Shell>
    );
  }

  const set = <K extends keyof Card>(k: K, v: Card[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const noReward = !form.rewardItemId && !form.rewardLabel.trim();

  return (
    <Shell>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <Heart className="h-4 w-4" /> Loyalty card
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Customers collect a stamp per order and claim a reward when the
            card is full. It shows only on their own card in the app — never on
            your public menu.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-medium text-zinc-700">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => set("isActive", e.target.checked)}
            className="h-4 w-4 rounded border-zinc-300"
          />
          Live
        </label>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Stamps needed" hint="Six is what most people expect.">
          <input
            type="number"
            min={2}
            max={20}
            value={form.stampsRequired}
            onChange={(e) => set("stampsRequired", Number(e.target.value))}
            className={input}
          />
        </Field>

        <Field
          label="Minimum spend per stamp"
          hint="Leave empty and any order earns one — including a bag of chips."
        >
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400">
              {symbol}
            </span>
            <input
              type="number"
              min={0}
              step="0.5"
              placeholder="Any order"
              value={form.minimumSpend ?? ""}
              onChange={(e) =>
                set("minimumSpend", e.target.value === "" ? null : Number(e.target.value))
              }
              className={`${input} pl-7`}
            />
          </div>
        </Field>

        <Field
          label="Reward"
          hint="What staff hand over when the card is full. Picked from the live menu, so it is something they actually make."
        >
          {brands.length > 1 && (
            <select
              value={activeBrand?.id ?? ""}
              onChange={(e) => setPickedBrand(e.target.value)}
              className={`${input} mb-2`}
            >
              {brands.map((b: any) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              value={itemSearch}
              onChange={(e) => setItemSearch(e.target.value)}
              placeholder="Search the menu…"
              className={`${input} pl-8`}
            />
          </div>
          {/* A scrolling list rather than a dropdown: a kebab shop's menu runs
              to a couple of hundred items, and a native select of that length
              is unusable on a laptop and worse on a tablet. */}
          <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-zinc-200">
            {items.length === 0 ? (
              <p className="p-3 text-xs text-zinc-400">
                No published menu for this brand yet — publish one and its items
                appear here.
              </p>
            ) : shown.length === 0 ? (
              <p className="p-3 text-xs text-zinc-400">
                Nothing matches &ldquo;{itemSearch}&rdquo;.
              </p>
            ) : (
              shown.map((i) => {
                const on = form.rewardItemId === i.id;
                return (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => {
                      set("rewardItemId", on ? null : i.id);
                      // Keep the wording in step with the item, so the
                      // customer's card and the kitchen ticket agree.
                      if (!on) set("rewardLabel", `Free ${i.name}`);
                    }}
                    className={`flex w-full items-center gap-2.5 border-b border-zinc-100 px-3 py-2 text-left last:border-b-0 ${
                      on ? "bg-rose-50" : "hover:bg-zinc-50"
                    }`}
                  >
                    {i.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={i.imageUrl}
                        alt=""
                        className="h-8 w-8 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <span className="h-8 w-8 shrink-0 rounded bg-zinc-100" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-zinc-900">
                        {i.name}
                      </span>
                      <span className="block truncate text-[11px] text-zinc-400">
                        {i.category} · {symbol}
                        {i.price.toFixed(2)}
                      </span>
                    </span>
                    {on && <Check className="h-4 w-4 shrink-0 text-rose-600" />}
                  </button>
                );
              })
            )}
          </div>
        </Field>

        <Field
          label="Reward expires after"
          hint="Days. Leave empty and it never expires."
        >
          <input
            type="number"
            min={1}
            placeholder="Never"
            value={form.rewardExpiryDays ?? ""}
            onChange={(e) =>
              set("rewardExpiryDays", e.target.value === "" ? null : Number(e.target.value))
            }
            className={input}
          />
        </Field>
      </div>

      <Field
        label="How it reads on their card"
        hint="Frozen onto a reward the moment it is earned, so changing this never rewrites a promise you already made."
      >
        <input
          value={form.rewardLabel}
          onChange={(e) => set("rewardLabel", e.target.value)}
          placeholder="Free regular chips"
          className={input}
        />
      </Field>

      {form.isActive && noReward && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          Choose a reward before going live, or every customer&apos;s card
          carries an empty promise.
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          disabled={save.isPending || (form.isActive && noReward)}
          onClick={() => save.mutate(form)}
          className="inline-flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-40"
        >
          {save.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : save.isSuccess ? (
            <Check className="h-4 w-4" />
          ) : null}
          Save card
        </button>
        {save.isError && (
          <span className="text-xs text-red-600">
            {(save.error as any)?.response?.data?.message ?? "Could not save."}
          </span>
        )}
      </div>
    </Shell>
  );
}

const input =
  "w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">{children}</div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3">
      <label className="block text-xs font-semibold text-zinc-700">{label}</label>
      {hint && <p className="mb-1 mt-0.5 text-[11px] text-zinc-400">{hint}</p>}
      {children}
    </div>
  );
}
