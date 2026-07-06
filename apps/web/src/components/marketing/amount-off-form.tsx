"use client";

// Phase AW-19 — Amount-off-order campaign form. Mirrors the
// percentage form one-to-one; the only operator-facing differences
// are the chips (£2 / £3 / £5 / £7 / £10) and that we POST
// amountOff instead of percentageOff.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X, Loader2, Check } from "lucide-react";
import toast from "react-hot-toast";
import {
  marketingClient,
  type CampaignAudience,
} from "@/lib/api/marketing.client";
import { brandsClient, type Brand } from "@/lib/api/locations.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";

interface Props {
  onCancel: () => void;
  onSaved: () => void;
}

const AMOUNT_CHIPS = [2, 3, 5, 7, 10];
const MIN_ORDER_CHIPS = [10, 15, 20, 25, 30];

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

export function AmountOffCampaignForm({ onCancel, onSaved }: Props) {
  const selectedLocationId = useSelectedLocationStore((s) => s.selectedLocationId);

  const [name, setName] = useState("Amount off order");
  const [amount, setAmount] = useState(5);
  const [amountCustom, setAmountCustom] = useState(false);

  const [brandIds, setBrandIds] = useState<string[]>([]);
  const [channels, setChannels] = useState<string[]>(["ONLINE"]);
  const [audience, setAudience] = useState<CampaignAudience>("ALL");

  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(in30);
  const [runUntilCancelled, setRunUntilCancelled] = useState(false);

  const [minOrder, setMinOrder] = useState<number | null>(20);
  const [minOrderCustom, setMinOrderCustom] = useState(false);

  const [goLive, setGoLive] = useState(true);

  const brandsQuery = useQuery({
    queryKey: ["brands", selectedLocationId ?? "tenant"],
    queryFn: () => brandsClient.list(selectedLocationId ?? undefined),
  });

  useEffect(() => {
    if (brandIds.length === 0 && (brandsQuery.data ?? []).length > 0) {
      setBrandIds([brandsQuery.data![0]!.id]);
    }
  }, [brandsQuery.data, brandIds.length]);

  const save = useMutation({
    mutationFn: async () => {
      if (brandIds.length === 0) throw new Error("Pick at least one brand");
      if (channels.length === 0) throw new Error("Pick at least one channel");
      const body = {
        type: "AMOUNT_OFF_ORDER" as const,
        name,
        audience,
        channels,
        amountOff: amount,
        minOrder: minOrder ?? undefined,
        startsAt: new Date(startDate).toISOString(),
        endsAt: runUntilCancelled
          ? undefined
          : new Date(endDate + "T23:59:59").toISOString(),
        status: (goLive ? "ACTIVE" : "DRAFT") as "ACTIVE" | "DRAFT",
      };
      const results = await Promise.all(
        brandIds.map((brandId) =>
          marketingClient.create({ ...body, brandId }),
        ),
      );
      return results;
    },
    onSuccess: (rows) => {
      toast.success(
        `Created ${rows.length} campaign${rows.length === 1 ? "" : "s"}`,
      );
      onSaved();
    },
    onError: (err: any) =>
      toast.error(
        err?.response?.data?.message ?? err?.message ?? "Failed to save",
      ),
  });

  const canSave =
    brandIds.length > 0 &&
    channels.length > 0 &&
    amount > 0 &&
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
              Amount off order
            </h2>
            <p className="text-xs text-zinc-500">
              Set a fixed money-off offer (e.g. £5 off £20+).
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
            <Label>Amount off</Label>
            <div className="flex flex-wrap gap-2">
              {AMOUNT_CHIPS.map((a) => (
                <Chip
                  key={a}
                  active={!amountCustom && amount === a}
                  onClick={() => {
                    setAmount(a);
                    setAmountCustom(false);
                  }}
                >
                  £{a}
                </Chip>
              ))}
              <Chip
                active={amountCustom}
                onClick={() => setAmountCustom(true)}
              >
                Custom
              </Chip>
              {amountCustom && (
                <input
                  type="number"
                  min={1}
                  step={0.5}
                  value={amount}
                  onChange={(e) => setAmount(Number(e.target.value) || 0)}
                  className="w-24 rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
                />
              )}
            </div>
          </Section>

          <Section title="Brands">
            {brandsQuery.isLoading ? (
              <div className="flex items-center justify-center py-6 text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : (brandsQuery.data ?? []).length === 0 ? (
              <p className="text-xs text-zinc-500">
                No brands at this location yet.
              </p>
            ) : (
              <div className="space-y-1.5">
                {(brandsQuery.data ?? []).map((b: Brand) => {
                  const on = brandIds.includes(b.id);
                  return (
                    <label
                      key={b.id}
                      className={`flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer ${
                        on
                          ? "border-violet-300 bg-violet-50"
                          : "border-zinc-200 hover:border-zinc-300"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setBrandIds((prev) =>
                            prev.includes(b.id)
                              ? prev.filter((id) => id !== b.id)
                              : [...prev, b.id],
                          )
                        }
                      />
                      <span className="text-sm text-zinc-900">{b.name}</span>
                      {b.cuisine && (
                        <span className="text-[11px] text-zinc-500">
                          · {b.cuisine}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </Section>

          <Section title="Channels">
            <p className="text-[11px] text-zinc-500 mb-2">
              Online ordering applies the offer automatically. POS lets the
              operator pick it at the till. Marketplace channels are flagged
              for export but not yet wired through.
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
                  Campaign stays active with no end date. Pause or delete it
                  from this page whenever you want.
                </p>
              </div>
            </label>
          </Section>

          <Section title="Minimum spend (optional)">
            <div className="flex flex-wrap gap-2">
              <Chip active={minOrder === null} onClick={() => setMinOrder(null)}>
                No minimum
              </Chip>
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
                  min={0}
                  value={minOrder ?? 0}
                  onChange={(e) => setMinOrder(Number(e.target.value) || 0)}
                  className="w-24 rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
                />
              )}
            </div>
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
              Unchecked = saved as a draft. Storefront + POS only apply ACTIVE
              campaigns.
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
            {brandIds.length > 1
              ? `Create ${brandIds.length} campaigns`
              : "Create campaign"}
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
