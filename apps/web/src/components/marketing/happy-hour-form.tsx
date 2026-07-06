"use client";

// Phase AW-19 — Happy hour campaign. Storewide discount that only
// applies on selected weekdays during a daily time window.
//
// Operator picks: percentage OR amount off, days-of-week, start +
// end time, brand, channels, audience, duration. Storefront's
// server-side resolver only surfaces this when "now" matches the
// day-of-week mask AND the time window.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X, Loader2, Check, Clock } from "lucide-react";
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

const PERCENT_CHIPS = [10, 15, 20, 25, 30, 50];
const AMOUNT_CHIPS = [2, 3, 5, 7, 10];
// JS Date.getDay() — 0=Sun ... 6=Sat. Reorder for UI Mon-first.
const DAYS: Array<{ id: number; short: string; long: string }> = [
  { id: 1, short: "Mon", long: "Monday" },
  { id: 2, short: "Tue", long: "Tuesday" },
  { id: 3, short: "Wed", long: "Wednesday" },
  { id: 4, short: "Thu", long: "Thursday" },
  { id: 5, short: "Fri", long: "Friday" },
  { id: 6, short: "Sat", long: "Saturday" },
  { id: 0, short: "Sun", long: "Sunday" },
];

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

export function HappyHourCampaignForm({ onCancel, onSaved }: Props) {
  const selectedLocationId = useSelectedLocationStore((s) => s.selectedLocationId);

  const [name, setName] = useState("Happy hour");
  const [discountMode, setDiscountMode] = useState<"percent" | "amount">("percent");
  const [percent, setPercent] = useState(20);
  const [percentCustom, setPercentCustom] = useState(false);
  const [amount, setAmount] = useState(5);
  const [amountCustom, setAmountCustom] = useState(false);

  const [brandIds, setBrandIds] = useState<string[]>([]);
  const [channels, setChannels] = useState<string[]>(["ONLINE"]);
  const [audience, setAudience] = useState<CampaignAudience>("ALL");

  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [startTime, setStartTime] = useState("14:00");
  const [endTime, setEndTime] = useState("17:00");

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
    if (brandIds.length === 0 && (brandsQuery.data ?? []).length > 0) {
      setBrandIds([brandsQuery.data![0]!.id]);
    }
  }, [brandsQuery.data, brandIds.length]);

  function toggleDay(d: number) {
    setDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d],
    );
  }

  const save = useMutation({
    mutationFn: async () => {
      if (brandIds.length === 0) throw new Error("Pick at least one brand");
      if (channels.length === 0) throw new Error("Pick at least one channel");
      if (days.length === 0) throw new Error("Pick at least one day");
      if (!startTime || !endTime) throw new Error("Set a time window");
      const body = {
        type: "HAPPY_HOUR" as const,
        name,
        audience,
        channels,
        percentageOff: discountMode === "percent" ? percent : undefined,
        amountOff: discountMode === "amount" ? amount : undefined,
        dailyStartTime: startTime,
        dailyEndTime: endTime,
        daysOfWeek: days,
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
    days.length > 0 &&
    !!startTime &&
    !!endTime &&
    (discountMode === "percent" ? percent > 0 : amount > 0) &&
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
            <Clock className="h-5 w-5 text-blue-600" />
            <div>
              <h2 className="text-base font-semibold text-zinc-900">
                Happy hour
              </h2>
              <p className="text-xs text-zinc-500">
                Storewide discount during a daily window on selected days.
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

          <Section title="Discount">
            <div className="flex gap-1.5 mb-3">
              <ModeChip
                active={discountMode === "percent"}
                onClick={() => setDiscountMode("percent")}
              >
                Percentage off
              </ModeChip>
              <ModeChip
                active={discountMode === "amount"}
                onClick={() => setDiscountMode("amount")}
              >
                Amount off
              </ModeChip>
            </div>
            {discountMode === "percent" ? (
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
            ) : (
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
            )}
          </Section>

          <Section title="Days">
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d) => {
                const on = days.includes(d.id);
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => toggleDay(d.id)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                      on
                        ? "border-blue-600 bg-blue-600 text-white"
                        : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
                    }`}
                  >
                    {d.short}
                  </button>
                );
              })}
            </div>
          </Section>

          <Section title="Time window">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">
                  Start
                </label>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="input"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">
                  End
                </label>
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="input"
                />
              </div>
            </div>
          </Section>

          <Section title="Brands">
            {brandsQuery.isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
            ) : (
              <div className="space-y-1.5">
                {(brandsQuery.data ?? []).map((b: Brand) => {
                  const on = brandIds.includes(b.id);
                  return (
                    <label
                      key={b.id}
                      className={`flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer ${
                        on
                          ? "border-blue-300 bg-blue-50"
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

function ModeChip({
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
      className={`rounded-full border px-3 py-1 text-xs font-medium ${
        active
          ? "border-blue-600 bg-blue-600 text-white"
          : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}
