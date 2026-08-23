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

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Heart, Loader2, Check } from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { useCurrency } from "@/hooks/use-currency";
import { productsClient } from "@/lib/api/catalog.client";

interface Card {
  isActive: boolean;
  stampsRequired: number;
  minimumSpend: number | string | null;
  rewardItemId: string | null;
  rewardLabel: string;
  rewardExpiryDays: number | null;
}

export function LoyaltyCardPanel({ brandId }: { brandId?: string | null }) {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const { symbol } = useCurrency();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<Card>({
    queryKey: ["loyalty-card-config", locationId],
    enabled: !!locationId,
    queryFn: () =>
      apiClient.get(`/v1/loyalty/cards/${locationId}`).then((r) => r.data),
  });

  // The reward is picked from the menu, so staff hand over a thing that
  // actually exists rather than reading a sentence someone typed.
  const { data: items } = useQuery({
    queryKey: ["loyalty-reward-items", brandId, locationId],
    enabled: !!locationId,
    queryFn: () =>
      brandId
        ? productsClient.list(brandId)
        : productsClient.listForLocation(String(locationId)),
  });

  const [form, setForm] = useState<Card | null>(null);
  useEffect(() => {
    if (data && !form) setForm({ ...data, minimumSpend: data.minimumSpend ?? null });
  }, [data, form]);

  const save = useMutation({
    mutationFn: (body: Card) =>
      apiClient.put(`/v1/loyalty/cards/${locationId}`, body).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["loyalty-card-config", locationId] });
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
        <label className="flex shrink-0 items-center gap-2 text-sm font-medium text-zinc-700">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => set("isActive", e.target.checked)}
            className="h-4 w-4 rounded border-zinc-300"
          />
          Live
        </label>
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

        <Field label="Reward" hint="What staff hand over when the card is full.">
          <select
            value={form.rewardItemId ?? ""}
            onChange={(e) => {
              const id = e.target.value || null;
              set("rewardItemId", id);
              const picked = (items ?? []).find((i: any) => i.id === id);
              // Keep the wording in step with the item, so the customer's card
              // and the kitchen ticket say the same thing.
              if (picked) set("rewardLabel", `Free ${picked.name}`);
            }}
            className={input}
          >
            <option value="">Choose an item…</option>
            {(items ?? []).map((i: any) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
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
