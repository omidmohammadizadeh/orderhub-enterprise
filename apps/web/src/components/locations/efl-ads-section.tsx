"use client";

// Locations → Brands → Eat For Less → Sponsored ads.
//
// A shop's own sponsored placement at the top of the Eat For Less app. Pay
// per tap, capped by a weekly budget and a most-per-tap; spend is taken back
// from the shop's next Eat For Less orders. Eat For Less can pause a shop's
// ads — then the switch is locked and the shop is told who to contact.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { eflClient, type EflAdCampaign, type EflShopAds } from "@/lib/api/efl.client";
import { formatCurrency } from "@/lib/utils";

const BUDGET_MIN = 5;
const BUDGET_MAX = 1000;
const BID_MIN = 0.1;
const BID_MAX = 5;
const BID_STEP = 0.05;

/** What a shop with no campaign yet starts from. */
const NEW_CAMPAIGN = { active: false, weeklyBudget: 20, maxBid: 0.5 } as const;

type AdsPatch = Partial<Pick<EflAdCampaign, "active" | "weeklyBudget" | "maxBid">>;

/** Inputs hold text so a half-typed "0." isn't fought by the field. */
interface AdsDraft {
  active?: boolean;
  weeklyBudget?: string;
  maxBid?: string;
}

export function eflAdsQueryKey(locationId: string) {
  return ["efl-ads", locationId] as const;
}

const gbp = (n: number) => formatCurrency(n, "GBP");

function parseMoney(s: string): number | null {
  const n = Number(s.trim());
  return s.trim() === "" || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}

export function EflAdsSection({ locationId }: { locationId: string }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: eflAdsQueryKey(locationId),
    queryFn: () => eflClient.ads(locationId),
  });

  const [draft, setDraft] = useState<AdsDraft>({});
  useEffect(() => setDraft({}), [locationId]);

  const save = useMutation({
    mutationFn: (patch: AdsPatch) => eflClient.saveAds(locationId, patch),
    onSuccess: (campaign) => {
      qc.setQueryData<EflShopAds>(eflAdsQueryKey(locationId), (prev) => (prev ? { ...prev, campaign } : prev));
      void qc.invalidateQueries({ queryKey: eflAdsQueryKey(locationId) });
      setDraft({});
      toast.success(campaign.active ? "Sponsored ads saved — you're on" : "Sponsored ads saved");
    },
    onError: (err: any) => toast.error(err?.response?.data?.message ?? "Couldn't save your ads"),
  });

  const ids = {
    heading: `efl-ads-heading-${locationId}`,
    budget: `efl-ads-budget-${locationId}`,
    budgetHint: `efl-ads-budget-hint-${locationId}`,
    bid: `efl-ads-bid-${locationId}`,
    bidHint: `efl-ads-bid-hint-${locationId}`,
  };

  if (query.isLoading) {
    return (
      <Shell headingId={ids.heading}>
        <div className="flex min-h-[184px] items-center gap-2 text-xs text-zinc-500" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading sponsored ads…
        </div>
      </Shell>
    );
  }

  if (query.isError || !query.data) {
    return (
      <Shell headingId={ids.heading}>
        <div className="flex min-h-[184px] flex-col items-start justify-center gap-2 text-xs text-red-700" role="alert">
          <span>
            {(query.error as any)?.response?.data?.message ?? "Couldn't load your sponsored ads."}
          </span>
          <button
            type="button"
            onClick={() => query.refetch()}
            className="h-9 rounded-lg border border-zinc-300 px-3 font-semibold text-zinc-800 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/30"
          >
            Try again
          </button>
        </div>
      </Shell>
    );
  }

  const { campaign, thisWeek, owed } = query.data;
  const saved = campaign ?? NEW_CAMPAIGN;
  const paused = !!campaign?.pausedByAdmin;

  const active = draft.active ?? saved.active;
  const budgetText = draft.weeklyBudget ?? saved.weeklyBudget.toFixed(2);
  const bidText = draft.maxBid ?? saved.maxBid.toFixed(2);
  const budget = parseMoney(budgetText);
  const bid = parseMoney(bidText);

  const budgetError =
    budget === null || budget < BUDGET_MIN || budget > BUDGET_MAX
      ? `Between ${gbp(BUDGET_MIN)} and ${gbp(BUDGET_MAX)} a week.`
      : null;
  const bidError =
    bid === null || bid < BID_MIN || bid > BID_MAX
      ? `Between ${gbp(BID_MIN)} and ${gbp(BID_MAX)} a tap.`
      : bid > (budget ?? Infinity)
        ? "Can't be more than your weekly budget."
        : null;

  const patch: AdsPatch = {};
  if (!campaign || active !== saved.active) patch.active = active;
  if (!campaign || budget !== saved.weeklyBudget) patch.weeklyBudget = budget ?? undefined;
  if (!campaign || bid !== saved.maxBid) patch.maxBid = bid ?? undefined;
  const dirty = campaign
    ? patch.active !== undefined || patch.weeklyBudget !== undefined || patch.maxBid !== undefined
    : Object.keys(draft).length > 0;
  const canSave = dirty && !budgetError && !bidError && !save.isPending;

  return (
    <Shell
      headingId={ids.heading}
      action={
        <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-zinc-900 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
          {active ? "On" : "Off"}
          <input
            type="checkbox"
            role="switch"
            aria-label="Sponsored ads on"
            className="peer sr-only"
            checked={active}
            disabled={paused || save.isPending}
            onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))}
          />
          <span
            aria-hidden="true"
            className="relative h-6 w-11 rounded-full bg-zinc-300 transition-colors peer-checked:bg-zinc-900 peer-focus-visible:ring-2 peer-focus-visible:ring-zinc-900/30 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5"
          />
        </label>
      }
    >
      <p className="text-[11px] leading-relaxed text-zinc-500">
        Show at the top of the Eat For Less app for customers near you. You only pay when someone taps your shop,
        and never more than your most-per-tap. Spend is taken from your next Eat For Less orders (up to half of each
        order&apos;s food), and shown on your Monday statement.
      </p>

      {paused && (
        <p role="status" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[11px] font-medium text-red-800">
          Eat For Less has paused your ads — contact{" "}
          <a href="mailto:partner@eatforless.co.uk" className="font-semibold underline underline-offset-2">
            partner@eatforless.co.uk
          </a>
        </p>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <MoneyField
          id={ids.budget}
          hintId={ids.budgetHint}
          label="Weekly budget"
          value={budgetText}
          min={BUDGET_MIN}
          max={BUDGET_MAX}
          step={1}
          hint={`Never more than this in a week. ${gbp(BUDGET_MIN)}–${gbp(BUDGET_MAX)}.`}
          error={budgetError}
          onChange={(v) => setDraft((d) => ({ ...d, weeklyBudget: v }))}
        />
        <MoneyField
          id={ids.bid}
          hintId={ids.bidHint}
          label="Most per tap"
          value={bidText}
          min={BID_MIN}
          max={BID_MAX}
          step={BID_STEP}
          hint={`The most a single tap can cost. ${gbp(BID_MIN)}–${gbp(BID_MAX)}.`}
          error={bidError}
          onChange={(v) => setDraft((d) => ({ ...d, maxBid: v }))}
        />
      </div>

      <div className="mt-4">
        <p className="mb-2 text-xs font-semibold text-zinc-700">This week</p>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat label="Shown" value={thisWeek.shows.toLocaleString("en-GB")} />
          <Stat label="Taps" value={thisWeek.taps.toLocaleString("en-GB")} />
          <Stat label="Orders from ads" value={thisWeek.orders.toLocaleString("en-GB")} />
          <Stat label="Spent" value={gbp(thisWeek.spent)} />
          <Stat
            label="Still to come off your orders"
            value={gbp(owed)}
            className="col-span-2 sm:col-span-1"
          />
        </dl>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        {Object.keys(draft).length > 0 && (
          <button
            type="button"
            onClick={() => setDraft({})}
            disabled={save.isPending}
            className="h-9 rounded-lg px-3 text-xs font-semibold text-zinc-600 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/30"
          >
            Discard
          </button>
        )}
        <button
          type="button"
          disabled={!canSave}
          onClick={() => save.mutate(patch)}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-zinc-900 px-4 text-xs font-semibold text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/30 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          Save ads
        </button>
      </div>
    </Shell>
  );
}

function Shell({
  headingId,
  action,
  children,
}: {
  headingId: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={headingId} className="border-t border-zinc-100 px-4 py-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h3 id={headingId} className="text-sm font-semibold text-zinc-900">
          Sponsored ads
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function MoneyField({
  id,
  hintId,
  label,
  value,
  min,
  max,
  step,
  hint,
  error,
  onChange,
}: {
  id: string;
  hintId: string;
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  hint: string;
  error: string | null;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-semibold text-zinc-700">
        {label}
      </label>
      <div className="relative">
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-zinc-500">
          £
        </span>
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-invalid={!!error}
          aria-describedby={hintId}
          onChange={(e) => onChange(e.target.value)}
          className={
            "h-10 w-full rounded-lg border pl-7 pr-3 text-sm tabular-nums focus:outline-none focus:ring-2 " +
            (error
              ? "border-red-400 focus:border-red-600 focus:ring-red-600/10"
              : "border-zinc-300 focus:border-zinc-900 focus:ring-zinc-900/10")
          }
        />
      </div>
      <p id={hintId} className={"text-[11px] " + (error ? "text-red-700" : "text-zinc-500")}>
        {error ?? hint}
      </p>
    </div>
  );
}

function Stat({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div className={`rounded-lg bg-zinc-50 px-3 py-2 ${className}`}>
      <dt className="text-[10px] font-medium leading-tight text-zinc-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-bold tabular-nums text-zinc-900">{value}</dd>
    </div>
  );
}
