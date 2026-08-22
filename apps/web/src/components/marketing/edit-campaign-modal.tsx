"use client";

// Phase MK-INSIGHTS — generic campaign editor.
//
// The 7 create forms are one-brand-per-submit builders; retrofitting each
// for edit would be a large, fragile change. Instead this single modal
// edits the fields that are safe and universal across every campaign type
// — name, status, audience, channels, the campaign window, and the
// primary money value for its type (percentage / amount / minimum spend).
// It PATCHes the existing campaign via marketingClient.update(). Item
// selections (BOGO / free-item / per-item pools) still belong to the
// create flow; a hint tells the operator to recreate for those.

import { useState } from "react";
import { useCurrency } from "@/hooks/use-currency";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X, Loader2, Check } from "lucide-react";
import toast from "react-hot-toast";
import {
  marketingClient,
  type MarketingCampaign,
  type CampaignAudience,
} from "@/lib/api/marketing.client";
import { brandsClient, type Brand } from "@/lib/api/locations.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";

interface Props {
  campaign: MarketingCampaign;
  onCancel: () => void;
  onSaved: () => void;
}

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

// Which primary value field applies to which campaign type.
const HAS_PERCENT = new Set([
  "PERCENTAGE_OFF",
  "PERCENT_OFF_ITEMS",
  "HAPPY_HOUR",
]);
const HAS_AMOUNT = new Set(["AMOUNT_OFF_ORDER"]);
// Order-level types that honour a minimum spend.
const HAS_MIN_ORDER = new Set([
  "PERCENTAGE_OFF",
  "AMOUNT_OFF_ORDER",
  "FREE_ITEM",
  "FREE_DELIVERY",
  "HAPPY_HOUR",
]);
const ITEM_BASED = new Set(["PERCENT_OFF_ITEMS", "BOGO", "FREE_ITEM"]);

const toDateInput = (s: string | null) => (s ? String(s).slice(0, 10) : "");
const numOrNull = (v: number | string | null): number | null =>
  v == null || v === "" ? null : Number(v);

export function EditCampaignModal({ campaign, onCancel, onSaved }: Props) {
  // Prices follow the selected location's currency, not a hardcoded pound.
  const { money, symbol } = useCurrency();
  const selectedLocationId = useSelectedLocationStore(
    (s) => s.selectedLocationId,
  );

  const [name, setName] = useState(campaign.name);
  const [status, setStatus] = useState(campaign.status);
  const [audience, setAudience] = useState<CampaignAudience>(campaign.audience);
  const [channels, setChannels] = useState<string[]>(campaign.channels ?? []);
  const [percent, setPercent] = useState<number>(
    Number(campaign.percentageOff ?? 20),
  );
  const [amount, setAmount] = useState<number>(Number(campaign.amountOff ?? 5));
  const [minOrder, setMinOrder] = useState<number | null>(
    numOrNull(campaign.minOrder),
  );
  const [startDate, setStartDate] = useState(toDateInput(campaign.startsAt));
  const [endDate, setEndDate] = useState(toDateInput(campaign.endsAt));
  const [runUntilCancelled, setRunUntilCancelled] = useState(
    campaign.endsAt == null,
  );

  // Brand name is display-only (brand is immutable on edit).
  const brandsQuery = useQuery({
    queryKey: ["brands", selectedLocationId ?? "tenant"],
    queryFn: () => brandsClient.list(selectedLocationId ?? undefined),
  });
  const brandName =
    (brandsQuery.data ?? []).find((b: Brand) => b.id === campaign.brandId)
      ?.name ?? null;

  const save = useMutation({
    mutationFn: async () => {
      if (channels.length === 0) throw new Error("Pick at least one channel");
      const body: Record<string, unknown> = {
        name,
        status,
        audience,
        channels,
        startsAt: startDate
          ? new Date(startDate).toISOString()
          : undefined,
        endsAt: runUntilCancelled
          ? null
          : endDate
            ? new Date(endDate + "T23:59:59").toISOString()
            : null,
      };
      if (HAS_PERCENT.has(campaign.type)) body.percentageOff = percent;
      if (HAS_AMOUNT.has(campaign.type)) body.amountOff = amount;
      if (HAS_MIN_ORDER.has(campaign.type))
        body.minOrder = minOrder ?? undefined;
      return marketingClient.update(campaign.id, body as any);
    },
    onSuccess: () => {
      toast.success("Campaign updated");
      onSaved();
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.message ?? err?.message ?? "Failed to save",
      ),
  });

  const canSave = name.trim().length > 0 && channels.length > 0 && !save.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-sm py-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 my-4">
        <header className="flex items-center justify-between border-b border-zinc-100 px-5 py-3 sticky top-0 bg-white rounded-t-xl">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              Edit campaign
            </h2>
            <p className="text-xs text-zinc-500">
              {prettyType(campaign.type)}
              {brandName ? ` · ${brandName}` : ""}
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

          {/* Primary value — depends on the campaign type */}
          {(HAS_PERCENT.has(campaign.type) ||
            HAS_AMOUNT.has(campaign.type)) && (
            <Section title="Promotion">
              {HAS_PERCENT.has(campaign.type) && (
                <div>
                  <Label>Percentage off</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={percent}
                      onChange={(e) => setPercent(Number(e.target.value) || 0)}
                      className="w-28 rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
                    />
                    <span className="text-sm text-zinc-500">%</span>
                  </div>
                </div>
              )}
              {HAS_AMOUNT.has(campaign.type) && (
                <div>
                  <Label>Amount off</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-zinc-500">£</span>
                    <input
                      type="number"
                      min={0}
                      step="0.5"
                      value={amount}
                      onChange={(e) => setAmount(Number(e.target.value) || 0)}
                      className="w-28 rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
                    />
                  </div>
                </div>
              )}
            </Section>
          )}

          {ITEM_BASED.has(campaign.type) && (
            <p className="rounded-md bg-amber-50 border border-amber-100 px-3 py-2 text-[11px] text-amber-800">
              This campaign targets specific items. Names, dates, channels,
              audience and status are editable here — to change which items
              are included, delete and recreate the campaign.
            </p>
          )}

          {/* Min spend */}
          {HAS_MIN_ORDER.has(campaign.type) && (
            <Section title="Minimum spend (optional)">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setMinOrder(null)}
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                    minOrder == null
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
                  }`}
                >
                  No minimum
                </button>
                <span className="text-sm text-zinc-500">£</span>
                <input
                  type="number"
                  min={0}
                  value={minOrder ?? 0}
                  onChange={(e) => setMinOrder(Number(e.target.value) || 0)}
                  className="w-28 rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
                />
              </div>
            </Section>
          )}

          {/* Channels */}
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

          {/* Audience */}
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

          {/* Duration */}
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
              <span className="text-sm text-zinc-900">Run until I cancel</span>
            </label>
          </Section>

          {/* Status */}
          <Section title="Status">
            <div className="flex flex-wrap gap-2">
              {(["ACTIVE", "PAUSED", "DRAFT", "ENDED"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                    status === s
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-zinc-500 mt-1">
              Storefront + POS only apply ACTIVE campaigns. Uber Eats sync
              follows the status: ACTIVE creates the promotion, anything else
              revokes it.
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
            Save changes
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

function prettyType(t: string): string {
  const map: Record<string, string> = {
    PERCENTAGE_OFF: "Per cent off order",
    AMOUNT_OFF_ORDER: "Amount off order",
    PERCENT_OFF_ITEMS: "Per cent off items",
    BOGO: "Buy 1, get 1 free",
    FREE_ITEM: "Free item with purchase",
    FREE_DELIVERY: "Free delivery",
    HAPPY_HOUR: "Happy hour",
  };
  return map[t] ?? t;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
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
