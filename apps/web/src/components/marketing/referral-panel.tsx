"use client";

// Refer-a-friend settings, per location.
//
// Sits beside the loyalty card for the same reason: this is the screen an
// operator opens when they want to give something away. Like the card, it is
// not a campaign — it is never advertised on the storefront to everybody, it
// is a code one customer hands another.
//
// Every field here is money, so each one says what it costs rather than just
// what it does.

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Users, Loader2, Check, X } from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { useCurrency } from "@/hooks/use-currency";

interface Program {
  isActive: boolean;
  referrerAmount: number | string;
  friendAmount: number | string;
  minimumSpend: number | string | null;
  maxPerCustomer: number;
  rewardExpiryDays: number | null;
}

export function ReferralPanel({ onClose }: { onClose?: () => void }) {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const { symbol } = useCurrency();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<Program>({
    queryKey: ["referral-program", locationId],
    enabled: !!locationId,
    queryFn: () =>
      apiClient.get(`/v1/loyalty/referrals/${locationId}`).then((r) => r.data),
  });

  const [form, setForm] = useState<Program | null>(null);
  useEffect(() => {
    if (data && !form) setForm({ ...data });
  }, [data, form]);

  const save = useMutation({
    mutationFn: (body: Program) =>
      apiClient
        .put(`/v1/loyalty/referrals/${locationId}`, body)
        .then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["referral-program", locationId] });
      onClose?.();
    },
  });

  if (!locationId) {
    return (
      <Shell>
        <p className="text-sm text-zinc-500">
          Pick a location — a referral offer belongs to one shop, not the whole
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

  const set = <K extends keyof Program>(k: K, v: Program[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const referrer = Number(form.referrerAmount) || 0;
  const friend = Number(form.friendAmount) || 0;
  const perReferral = referrer + friend;
  const worstCase = perReferral * (form.maxPerCustomer || 0);
  const payingNobody = referrer <= 0 && friend <= 0;

  return (
    <Shell>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <Users className="h-4 w-4" /> Refer a friend
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Customers share a code. When someone new orders with it, both get
            money off — added to their reward card, not to your public menu.
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
        <Field label="Your customer gets" hint="For introducing someone new.">
          <Money symbol={symbol}>
            <input
              type="number"
              min={0}
              step="0.5"
              value={form.referrerAmount}
              onChange={(e) => set("referrerAmount", e.target.value)}
              className={`${input} pl-7`}
            />
          </Money>
        </Field>

        <Field
          label="Their friend gets"
          hint="Often the larger of the two — it is buying a first order."
        >
          <Money symbol={symbol}>
            <input
              type="number"
              min={0}
              step="0.5"
              value={form.friendAmount}
              onChange={(e) => set("friendAmount", e.target.value)}
              className={`${input} pl-7`}
            />
          </Money>
        </Field>

        <Field
          label="Friend must spend at least"
          hint="Leave empty and a bag of chips pays out both sides."
        >
          <Money symbol={symbol}>
            <input
              type="number"
              min={0}
              step="0.5"
              placeholder="Any order"
              value={form.minimumSpend ?? ""}
              onChange={(e) =>
                set(
                  "minimumSpend",
                  e.target.value === "" ? null : Number(e.target.value),
                )
              }
              className={`${input} pl-7`}
            />
          </Money>
        </Field>

        <Field
          label="Most referrals per customer"
          hint="One person with a group chat, uncapped, is an open cheque."
        >
          <input
            type="number"
            min={1}
            max={500}
            value={form.maxPerCustomer}
            onChange={(e) => set("maxPerCustomer", Number(e.target.value))}
            className={input}
          />
        </Field>
      </div>

      <Field
        label="Rewards expire after"
        hint="Days. Leave empty and they never expire."
      >
        <input
          type="number"
          min={1}
          placeholder="Never"
          value={form.rewardExpiryDays ?? ""}
          onChange={(e) =>
            set(
              "rewardExpiryDays",
              e.target.value === "" ? null : Number(e.target.value),
            )
          }
          className={input}
        />
      </Field>

      {/* The number an operator actually needs and would otherwise work out on
          the back of an envelope — or not at all. */}
      <div className="mt-4 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600">
        Each successful referral costs you{" "}
        <strong className="text-zinc-900">
          {symbol}
          {perReferral.toFixed(2)}
        </strong>{" "}
        across both sides. One customer at the cap is up to{" "}
        <strong className="text-zinc-900">
          {symbol}
          {worstCase.toFixed(2)}
        </strong>
        .
      </div>

      {form.isActive && payingNobody && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          Set an amount for at least one side, or the code gives nothing and
          nobody shares it twice.
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          disabled={save.isPending || (form.isActive && payingNobody)}
          onClick={() => save.mutate(form)}
          className="inline-flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-40"
        >
          {save.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : save.isSuccess ? (
            <Check className="h-4 w-4" />
          ) : null}
          Save
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

function Money({
  symbol,
  children,
}: {
  symbol: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400">
        {symbol}
      </span>
      {children}
    </div>
  );
}

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
