"use client";

// Uber Eats channel management modal — everything for a connected store in
// one organised dialog instead of a cramped inline expansion: live status +
// open/pause, per-endpoint HTTP acknowledgments (cert evidence), integration
// / store / ordering details, hours + prep push, holiday hours editor, and
// a danger-zone disconnect.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  Clock,
  Loader2,
  Pause,
  Play,
  Plug,
  RefreshCw,
  Store,
  Trash2,
  X,
} from "lucide-react";
import toast from "react-hot-toast";
import { apiClient } from "@/lib/api/client";
import { PlatformLogo } from "@/components/ui/platform-logo";

type UberOverview = {
  storeId: string | null;
  checks: Array<{
    name: string;
    ok: boolean;
    httpStatus: number | null;
    error?: string;
  }>;
  store: {
    name: string | null;
    address: string | null;
    timezone: string | null;
    onboardingStatus: string | null;
    autoAccept: boolean | null;
    prepTimeSeconds: number | null;
    fulfillment: Record<string, boolean> | null;
  } | null;
  status: {
    status: string;
    offlineUntil: string | null;
    offlineReason: string | null;
  } | null;
  integration: {
    enabled: boolean | null;
    integratorStoreId: string | null;
    integratorBrandId: string | null;
    orderManagerClientId: string | null;
  } | null;
};

type UberHoliday = {
  date: string;
  closed: boolean;
  periods: Array<{ start: string; end: string }>;
};

export function UberEatsManageModal({
  connectionId,
  storeId,
  open,
  onClose,
  onChanged,
}: {
  connectionId: string;
  storeId: string | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const err = (e: any) =>
    toast.error(
      e?.response?.data?.message ?? e?.message ?? "Uber Eats request failed",
    );

  const overview = useQuery({
    queryKey: ["ubereats-overview", connectionId],
    queryFn: () =>
      apiClient
        .get(`/v1/integrations/ubereats/${connectionId}/overview`)
        .then((r) => r.data as UberOverview),
    enabled: open,
    refetchOnWindowFocus: false,
  });

  const pause = useMutation({
    mutationFn: () =>
      apiClient.post(`/v1/integrations/ubereats/${connectionId}/pause`, {}),
    onSuccess: () => {
      toast.success("Uber Eats store paused");
      overview.refetch();
      onChanged();
    },
    onError: err,
  });
  const resume = useMutation({
    mutationFn: () =>
      apiClient.post(`/v1/integrations/ubereats/${connectionId}/resume`, {}),
    onSuccess: () => {
      toast.success("Uber Eats store open");
      overview.refetch();
      onChanged();
    },
    onError: err,
  });
  const pushHours = useMutation({
    mutationFn: () =>
      apiClient
        .post(`/v1/integrations/ubereats/${connectionId}/publish-hours`, {})
        .then((r) => r.data as { prep?: any; menu?: any }),
    onSuccess: (d) => {
      const prepMin = d.prep?.defaultPrepTimeSeconds
        ? Math.round(d.prep.defaultPrepTimeSeconds / 60)
        : null;
      toast.success(
        `Pushed to Uber${prepMin ? ` — prep ${prepMin} min` : ""}, hours updated`,
      );
      overview.refetch();
    },
    onError: err,
  });
  const disconnect = useMutation({
    mutationFn: () =>
      apiClient.post(
        `/v1/integrations/ubereats/${connectionId}/disconnect`,
        {},
      ),
    onSuccess: () => {
      toast.success("Uber Eats disconnected");
      onChanged();
      onClose();
    },
    onError: err,
  });

  // ── Holiday hours (POST overwrites the complete set) ─────────────────────
  const [holidays, setHolidays] = useState<UberHoliday[]>([]);
  const [holidaysDirty, setHolidaysDirty] = useState(false);
  const holidayQuery = useQuery({
    queryKey: ["ubereats-holiday-hours", connectionId],
    queryFn: () =>
      apiClient
        .get(`/v1/integrations/ubereats/${connectionId}/holiday-hours`)
        .then((r) => r.data as { holidays: UberHoliday[] }),
    enabled: open,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (holidayQuery.data && !holidaysDirty) {
      setHolidays(holidayQuery.data.holidays ?? []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holidayQuery.data]);
  const saveHolidays = useMutation({
    mutationFn: () =>
      apiClient.post(
        `/v1/integrations/ubereats/${connectionId}/holiday-hours`,
        { holidays },
      ),
    onSuccess: () => {
      toast.success("Holiday hours pushed to Uber Eats");
      setHolidaysDirty(false);
      holidayQuery.refetch();
    },
    onError: err,
  });
  const editHoliday = (i: number, patch: Partial<UberHoliday>) => {
    setHolidays((h) =>
      h.map((row, idx) => (idx === i ? { ...row, ...patch } : row)),
    );
    setHolidaysDirty(true);
  };

  if (!open) return null;

  const o = overview.data;
  const online = o?.status?.status === "ONLINE";

  const Section = ({
    icon: Icon,
    title,
    children,
    className = "",
  }: {
    icon: React.ElementType;
    title: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <section
      className={`rounded-xl border border-zinc-200 bg-white p-4 ${className}`}
    >
      <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-zinc-800">
        <Icon className="h-3.5 w-3.5 text-zinc-400" />
        {title}
      </h3>
      {children}
    </section>
  );

  const Line = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="shrink-0 text-zinc-500">{label}</span>
      <span className="text-right font-medium text-zinc-800">
        {value ?? "—"}
      </span>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-zinc-50 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-5 py-4">
          <PlatformLogo platform="UBER_EATS" size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-zinc-900">
                Uber Eats
              </h2>
              {o?.status && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${online ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}
                >
                  {o.status.status}
                  {o.status.offlineUntil
                    ? ` until ${new Date(o.status.offlineUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                    : ""}
                </span>
              )}
            </div>
            <p className="truncate text-xs text-zinc-500">
              {o?.store?.name ?? "Store"} · {storeId ?? "—"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-5 py-3">
          <button
            onClick={() => resume.mutate()}
            disabled={resume.isPending}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {resume.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Open store
          </button>
          <button
            onClick={() => pause.mutate()}
            disabled={pause.isPending}
            className="flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100 disabled:opacity-50"
          >
            {pause.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Pause className="h-3.5 w-3.5" />
            )}
            Pause store
          </button>
          <button
            onClick={() => pushHours.mutate()}
            disabled={pushHours.isPending}
            title="Prep time via Update Prep Time; opening hours via the live menu's service_availability"
            className="flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
          >
            {pushHours.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Clock className="h-3.5 w-3.5" />
            )}
            Push hours + prep
          </button>
          <div className="ml-auto">
            <button
              onClick={() => overview.refetch()}
              disabled={overview.isFetching}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${overview.isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {/* Endpoint acknowledgments — live cert evidence */}
          {o?.checks && (
            <div className="flex flex-wrap gap-1.5">
              {o.checks.map((c) => (
                <span
                  key={c.name}
                  title={c.error ?? undefined}
                  className={`rounded-md px-2 py-1 text-[10px] font-medium ${c.ok ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}
                >
                  {c.name} · {c.httpStatus ?? "ERR"}
                </span>
              ))}
            </div>
          )}

          {overview.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking with Uber…
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Section icon={Store} title="Store">
                <Line label="Name" value={o?.store?.name} />
                <Line label="Address" value={o?.store?.address} />
                <Line label="Timezone" value={o?.store?.timezone} />
                <Line label="Onboarding" value={o?.store?.onboardingStatus} />
              </Section>

              <Section icon={Plug} title="Integration">
                <Line
                  label="Status"
                  value={
                    o?.integration?.enabled == null
                      ? "—"
                      : o.integration.enabled
                        ? "Enabled — managed by OrderHub"
                        : "Disabled"
                  }
                />
                <Line
                  label="Integrator store id"
                  value={
                    <span className="font-mono text-[10px]">
                      {o?.integration?.integratorStoreId ?? "—"}
                    </span>
                  }
                />
                {o?.integration?.orderManagerClientId && (
                  <Line
                    label="Order manager"
                    value={o.integration.orderManagerClientId}
                  />
                )}
              </Section>

              <Section icon={Clock} title="Ordering" className="sm:col-span-2">
                <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
                  <Line
                    label="Store"
                    value={
                      o?.status ? (
                        <span
                          className={
                            online ? "text-emerald-700" : "text-red-700"
                          }
                        >
                          {o.status.status}
                        </span>
                      ) : (
                        "—"
                      )
                    }
                  />
                  <Line
                    label="Prep time"
                    value={
                      o?.store?.prepTimeSeconds != null
                        ? `${Math.round(o.store.prepTimeSeconds / 60)} min`
                        : "—"
                    }
                  />
                  <Line
                    label="Auto accept"
                    value={
                      o?.store?.autoAccept == null
                        ? "—"
                        : o.store.autoAccept
                          ? "Enabled"
                          : "Disabled"
                    }
                  />
                  <Line
                    label="Offline reason"
                    value={o?.status?.offlineReason ?? "—"}
                  />
                </div>
                {o?.store?.fulfillment && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {Object.entries(o.store.fulfillment)
                      .filter(([, v]) => v)
                      .map(([k]) => (
                        <span
                          key={k}
                          className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600"
                        >
                          {k.replaceAll("_", " ").toLowerCase()}
                        </span>
                      ))}
                  </div>
                )}
              </Section>

              <Section
                icon={CalendarDays}
                title="Holiday hours"
                className="sm:col-span-2"
              >
                <p className="mb-2 text-[11px] text-zinc-500">
                  Date-specific exceptions to normal hours — e.g. closed on
                  Christmas Day, short hours on New Year's Eve.
                </p>
                {holidayQuery.isLoading ? (
                  <p className="text-xs text-zinc-500">Loading…</p>
                ) : (
                  <div className="space-y-2">
                    {holidays.length === 0 && (
                      <p className="text-xs text-zinc-500">
                        No holiday hours set on Uber.
                      </p>
                    )}
                    {holidays.map((h, i) => (
                      <div
                        key={`${h.date}-${i}`}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-xs"
                      >
                        <input
                          type="date"
                          value={h.date}
                          onChange={(e) =>
                            editHoliday(i, { date: e.target.value })
                          }
                          className="rounded border border-zinc-300 bg-white px-1.5 py-0.5"
                        />
                        <label className="flex items-center gap-1.5 text-zinc-600">
                          <input
                            type="checkbox"
                            checked={h.closed}
                            onChange={(e) =>
                              editHoliday(i, {
                                closed: e.target.checked,
                                periods: e.target.checked
                                  ? []
                                  : [{ start: "09:00", end: "17:00" }],
                              })
                            }
                          />
                          Closed all day
                        </label>
                        {!h.closed && (
                          <span className="flex items-center gap-1.5">
                            <input
                              type="time"
                              value={h.periods[0]?.start ?? "09:00"}
                              onChange={(e) =>
                                editHoliday(i, {
                                  periods: [
                                    {
                                      start: e.target.value,
                                      end: h.periods[0]?.end ?? "17:00",
                                    },
                                  ],
                                })
                              }
                              className="rounded border border-zinc-300 bg-white px-1.5 py-0.5"
                            />
                            <span className="text-zinc-400">–</span>
                            <input
                              type="time"
                              value={h.periods[0]?.end ?? "17:00"}
                              onChange={(e) =>
                                editHoliday(i, {
                                  periods: [
                                    {
                                      start: h.periods[0]?.start ?? "09:00",
                                      end: e.target.value,
                                    },
                                  ],
                                })
                              }
                              className="rounded border border-zinc-300 bg-white px-1.5 py-0.5"
                            />
                          </span>
                        )}
                        <button
                          onClick={() => {
                            setHolidays((rows) =>
                              rows.filter((_, idx) => idx !== i),
                            );
                            setHolidaysDirty(true);
                          }}
                          className="ml-auto rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600"
                          title="Remove"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setHolidays((rows) => [
                            ...rows,
                            { date: "", closed: true, periods: [] },
                          ]);
                          setHolidaysDirty(true);
                        }}
                        className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                      >
                        + Add date
                      </button>
                      {holidaysDirty && (
                        <button
                          onClick={() => saveHolidays.mutate()}
                          disabled={saveHolidays.isPending}
                          className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {saveHolidays.isPending && (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          )}
                          Save to Uber
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </Section>
            </div>
          )}

          {/* Danger zone */}
          <section className="rounded-xl border border-red-200 bg-red-50/50 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-xs font-semibold text-red-800">
                  Disconnect Uber Eats
                </h3>
                <p className="text-[11px] text-red-600/80">
                  Removes the store link from OrderHub. The store itself stays
                  live on Uber.
                </p>
              </div>
              <button
                onClick={() => disconnect.mutate()}
                disabled={disconnect.isPending}
                className="flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
              >
                {disconnect.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                Disconnect
              </button>
            </div>
          </section>

          <p className="text-center text-[10px] text-zinc-400">
            The data on this panel comes live from Uber Eats.
          </p>
        </div>
      </div>
    </div>
  );
}
