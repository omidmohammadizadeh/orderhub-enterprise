"use client";

// Phase AW-15 — Stop Taking Orders / Busy Mode modal.
//
// Operator flow:
//   1. Scope: whole location (all brands + all channels) OR pick a
//      brand AND optionally a single channel.
//   2. Mode: Stop accepting orders (paused) OR Busy (still accepting,
//      add extra prep time).
//   3. Duration: 1h / 2h / 4h / 6h / 12h / until tomorrow / until
//      further notice / custom datetime.
//   4. Reason: 4 preset chips + free-text "other".
//   5. Confirm → POST /v1/pauses.
//
// The active-pause list is also shown so the operator can resume any
// scope in one click. Resume just deletes the row.

import { useEffect, useMemo, useState } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { X, Pause, Play, AlertCircle, Loader2, Clock } from "lucide-react";
import toast from "react-hot-toast";
import {
  pausesClient,
  CHANNELS,
  DURATIONS,
  type PauseChannel,
  type PauseDuration,
  type PauseMode,
  type PauseRow,
} from "@/lib/api/pauses.client";
import { brandsClient, type Brand } from "@/lib/api/locations.client";

const CHANNEL_LABELS: Record<PauseChannel, string> = {
  ONLINE: "Online ordering",
  POS: "POS",
  JUST_EAT: "Just Eat",
  UBER_EATS: "Uber Eats",
  DELIVEROO: "Deliveroo",
  WHATSAPP: "WhatsApp",
  HUBRISE: "HubRise",
};

const DURATION_LABELS: Record<PauseDuration, string> = {
  "1h": "1 hour",
  "2h": "2 hours",
  "4h": "4 hours",
  "6h": "6 hours",
  "12h": "12 hours",
  until_tomorrow: "Until tomorrow",
  until_further_notice: "Until further notice",
};

const REASON_PRESETS = [
  "Closing early",
  "Shop is busy",
  "Issue in the shop",
];

interface Props {
  open: boolean;
  locationId: string;
  onClose: () => void;
}

export function StopTakingOrdersModal({ open, locationId, onClose }: Props) {
  const qc = useQueryClient();

  // ── Active pauses (list + per-row resume) ─────────────────────────
  const activeQuery = useQuery({
    queryKey: ["pauses", "location", locationId],
    queryFn: () => pausesClient.list(locationId),
    enabled: open && !!locationId,
    refetchInterval: 20_000,
  });
  const active = activeQuery.data ?? [];

  // ── Brand options for per-brand scope ──────────────────────────────
  const brandsQuery = useQuery({
    queryKey: ["brands", locationId],
    queryFn: () => brandsClient.list(locationId),
    enabled: open && !!locationId,
  });
  const brands = brandsQuery.data ?? [];

  // ── Form state ────────────────────────────────────────────────────
  const [scope, setScope] = useState<"location" | "brand">("location");
  const [brandId, setBrandId] = useState<string>("");
  const [channel, setChannel] = useState<PauseChannel | "">("");
  const [mode, setMode] = useState<PauseMode>("paused");
  const [duration, setDuration] = useState<PauseDuration | "custom">("1h");
  const [customResumeAt, setCustomResumeAt] = useState<string>("");
  const [reasonPreset, setReasonPreset] = useState<string | null>(
    REASON_PRESETS[0]!,
  );
  const [reasonOther, setReasonOther] = useState("");
  const [extraPrepTime, setExtraPrepTime] = useState<number>(15);

  useEffect(() => {
    if (open) {
      // Reset form on every open.
      setScope("location");
      setBrandId("");
      setChannel("");
      setMode("paused");
      setDuration("1h");
      setCustomResumeAt("");
      setReasonPreset(REASON_PRESETS[0]!);
      setReasonOther("");
      setExtraPrepTime(15);
    }
  }, [open]);

  // ── Mutations ─────────────────────────────────────────────────────
  const pauseMutation = useMutation({
    mutationFn: () => {
      const reason = reasonPreset === null ? reasonOther : reasonPreset;
      return pausesClient.pause({
        locationId,
        brandId: scope === "brand" && brandId ? brandId : undefined,
        channel: scope === "brand" && channel ? channel : undefined,
        mode,
        duration: duration === "custom" ? undefined : duration,
        customResumeAt:
          duration === "custom"
            ? new Date(customResumeAt).toISOString()
            : undefined,
        reason: reason || undefined,
        extraPrepTime: mode === "busy" ? extraPrepTime : undefined,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["pauses", "location", locationId],
      });
      toast.success(
        mode === "paused" ? "Storefront paused" : "Busy mode on",
      );
      onClose();
    },
    onError: (err: any) =>
      toast.error(
        `Failed: ${err?.response?.data?.message ?? err?.message ?? "Unknown error"}`,
      ),
  });

  const resumeMutation = useMutation({
    mutationFn: (rowId: string) => pausesClient.resume({ rowId }),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["pauses", "location", locationId],
      });
      toast.success("Resumed");
    },
  });

  const brandNameById = useMemo(
    () => new Map(brands.map((b: Brand) => [b.id, b.name])),
    [brands],
  );

  const canSubmit =
    !pauseMutation.isPending &&
    (scope === "location" || !!brandId) &&
    (duration !== "custom" || !!customResumeAt) &&
    (mode !== "busy" || extraPrepTime > 0);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-lg max-h-[92vh] flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              Stop taking orders
            </h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Pause a whole location or one brand/channel for a set time.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* ── Active pauses ────────────────────────────────────── */}
          {active.length > 0 && (
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                Currently paused
              </h3>
              <ul className="space-y-1.5">
                {active.map((row: PauseRow) => (
                  <li
                    key={row.id}
                    className="flex items-start justify-between gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-zinc-900">
                        {scopeLabel(row, brandNameById)}
                      </p>
                      <p className="mt-0.5 text-[10px] text-zinc-500">
                        {row.mode === "busy"
                          ? `Busy +${row.extraPrepTime ?? "?"}m · `
                          : "Paused · "}
                        {row.resumeAt
                          ? `until ${new Date(row.resumeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} on ${new Date(row.resumeAt).toLocaleDateString([], { day: "numeric", month: "short" })}`
                          : "until you resume"}
                      </p>
                      {row.reason && (
                        <p className="mt-0.5 text-[10px] italic text-zinc-500">
                          &ldquo;{row.reason}&rdquo;
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => resumeMutation.mutate(row.id)}
                      disabled={resumeMutation.isPending}
                      className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      <Play className="h-3 w-3" /> Resume
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ── Mode selector ────────────────────────────────────── */}
          <Section title="Action">
            <div className="flex gap-2">
              <ModeButton
                active={mode === "paused"}
                onClick={() => setMode("paused")}
                icon={<Pause className="h-3.5 w-3.5" />}
                label="Stop accepting orders"
              />
              <ModeButton
                active={mode === "busy"}
                onClick={() => setMode("busy")}
                icon={<Clock className="h-3.5 w-3.5" />}
                label="Busy (extra prep time)"
              />
            </div>
          </Section>

          {/* ── Scope ─────────────────────────────────────────────── */}
          <Section title="Scope">
            <div className="flex gap-2">
              <ScopeButton
                active={scope === "location"}
                onClick={() => setScope("location")}
                label="Whole location"
                sub="Every brand + channel"
              />
              <ScopeButton
                active={scope === "brand"}
                onClick={() => setScope("brand")}
                label="One brand"
                sub="Optionally one channel"
              />
            </div>
            {scope === "brand" && (
              <div className="mt-3 space-y-2">
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  Brand
                </label>
                <select
                  value={brandId}
                  onChange={(e) => setBrandId(e.target.value)}
                  className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                >
                  <option value="">— Pick a brand —</option>
                  {brands.map((b: Brand) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  Channel (optional)
                </label>
                <select
                  value={channel}
                  onChange={(e) =>
                    setChannel(e.target.value as PauseChannel | "")
                  }
                  className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
                >
                  <option value="">All channels</option>
                  {CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {CHANNEL_LABELS[c]}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </Section>

          {/* ── Duration ──────────────────────────────────────────── */}
          <Section title="Duration">
            <div className="grid grid-cols-2 gap-2">
              {DURATIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDuration(d)}
                  className={`rounded-md border px-3 py-1.5 text-left text-xs font-medium transition-colors ${
                    duration === d
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
                  }`}
                >
                  {DURATION_LABELS[d]}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setDuration("custom")}
                className={`rounded-md border px-3 py-1.5 text-left text-xs font-medium transition-colors ${
                  duration === "custom"
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
                }`}
              >
                Custom date
              </button>
            </div>
            {duration === "custom" && (
              <input
                type="datetime-local"
                value={customResumeAt}
                onChange={(e) => setCustomResumeAt(e.target.value)}
                className="mt-2 w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
              />
            )}
          </Section>

          {/* ── Busy: extra prep minutes ─────────────────────────── */}
          {mode === "busy" && (
            <Section title="Extra prep time (minutes)">
              <input
                type="number"
                min={5}
                max={240}
                step={5}
                value={extraPrepTime}
                onChange={(e) =>
                  setExtraPrepTime(parseInt(e.target.value, 10) || 0)
                }
                className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
              />
            </Section>
          )}

          {/* ── Reason ────────────────────────────────────────────── */}
          <Section title="Reason (shown to customers)">
            <div className="flex flex-wrap gap-2">
              {REASON_PRESETS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => {
                    setReasonPreset(r);
                    setReasonOther("");
                  }}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    reasonPreset === r
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
                  }`}
                >
                  {r}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setReasonPreset(null)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  reasonPreset === null
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
                }`}
              >
                Other…
              </button>
            </div>
            {reasonPreset === null && (
              <input
                value={reasonOther}
                onChange={(e) => setReasonOther(e.target.value)}
                placeholder="Type a reason…"
                className="mt-2 w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
              />
            )}
          </Section>
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-zinc-100 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            onClick={() => pauseMutation.mutate()}
            disabled={!canSubmit}
            className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-semibold text-white ${
              mode === "paused"
                ? "bg-red-600 hover:bg-red-700"
                : "bg-amber-600 hover:bg-amber-700"
            } disabled:opacity-50`}
          >
            {pauseMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : mode === "paused" ? (
              <>
                <AlertCircle className="h-3.5 w-3.5" /> Stop taking orders
              </>
            ) : (
              <>
                <Clock className="h-3.5 w-3.5" /> Go busy mode
              </>
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
        active
          ? "border-zinc-900 bg-zinc-900 text-white"
          : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function ScopeButton({
  active,
  onClick,
  label,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
        active
          ? "border-zinc-900 bg-zinc-900 text-white"
          : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"
      }`}
    >
      <span className="font-semibold">{label}</span>
      <span
        className={`text-[10px] ${active ? "text-white/70" : "text-zinc-500"}`}
      >
        {sub}
      </span>
    </button>
  );
}

function scopeLabel(row: PauseRow, brandNames: Map<string, string>): string {
  const parts: string[] = [];
  if (row.brandId) {
    parts.push(brandNames.get(row.brandId) ?? "Brand");
  } else {
    parts.push("Whole location");
  }
  if (row.channel) {
    parts.push(`· ${CHANNEL_LABELS[row.channel]}`);
  }
  return parts.join(" ");
}
