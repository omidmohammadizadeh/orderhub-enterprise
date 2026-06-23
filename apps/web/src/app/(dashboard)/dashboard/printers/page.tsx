"use client";

// Phase AS-4 — Printer dashboard.
//
// Four tabs: Printers | Stations | Agents | Alerts. The header above
// the tabs shows the live counters (online / offline / queue depth /
// failed-last-24h / last print time). Live updates come from
// printer:job:created / printer:agent:online events when the
// existing sockets fire — for AS-4 we lean on React Query
// refetchInterval as the safety net.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Printer as PrinterIcon,
  Wrench,
  Cpu,
  Bell,
  Wifi,
  WifiOff,
  Layers,
  Loader2,
  Zap,
} from "lucide-react";
import {
  printersClient,
  type Widgets,
} from "@/lib/api/printers.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { hasNativeBridge } from "@/lib/printing/bridge";
import { PrintersTab } from "@/components/printers/printers-tab";
import { StationsTab } from "@/components/printers/stations-tab";
import { AgentsTab } from "@/components/printers/agents-tab";
import { AlertsTab } from "@/components/printers/alerts-tab";
import { AutomationTab } from "@/components/printers/automation-tab";

type Tab = "printers" | "stations" | "agents" | "alerts" | "automation";

export default function PrintersPage() {
  const [tab, setTab] = useState<Tab>("printers");
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const qc = useQueryClient();

  const clearQueue = useMutation({
    mutationFn: () => printersClient.clearQueue(locationId ?? undefined),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ["printers"] });
      qc.invalidateQueries({ queryKey: ["print-jobs"] });
      alert(`Cleared ${r?.cleared ?? 0} job(s) from the queue.`);
    },
  });

  const widgetsQuery = useQuery({
    queryKey: ["printers", "widgets", locationId ?? "all"],
    queryFn: () => printersClient.widgets(locationId ?? undefined),
    refetchInterval: 15_000,
  });
  // Also pull the printer list so the Online/Offline counts above the
  // tabs can recognise Bluetooth printers connected via the tablet
  // bridge as "Online". The API's widgets endpoint only counts
  // isOnline-in-DB which is stuck at false for bridge-only printers.
  const printersQuery = useQuery({
    queryKey: ["printers", "list"],
    queryFn: () => printersClient.list(),
    refetchInterval: 15_000,
    enabled: hasNativeBridge(),
  });
  const bridgeOnlineExtra = hasNativeBridge()
    ? (printersQuery.data ?? []).filter(
        (p: any) =>
          (!locationId || p.locationId === locationId) &&
          p.connectionType === "BLUETOOTH" &&
          p.ipAddress &&
          !p.isOnline,
      ).length
    : 0;
  const rawWidgets: Widgets | undefined = widgetsQuery.data;
  const w: Widgets | undefined = rawWidgets
    ? {
        ...rawWidgets,
        online: rawWidgets.online + bridgeOnlineExtra,
        offline: Math.max(0, rawWidgets.offline - bridgeOnlineExtra),
      }
    : undefined;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Printers</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Configure printers, stations, agents, and notification alerts.
          </p>
        </div>
        <button
          onClick={() => {
            if (confirm("Clear all pending print jobs from the queue?"))
              clearQueue.mutate();
          }}
          disabled={clearQueue.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {clearQueue.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Layers className="h-4 w-4" />
          )}
          Clear queue
        </button>
      </div>

      {/* Widget strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Widget
          label="Online"
          value={w?.online ?? 0}
          icon={Wifi}
          tone="emerald"
        />
        <Widget
          label="Offline"
          value={w?.offline ?? 0}
          icon={WifiOff}
          tone="amber"
        />
        <Widget label="Queue" value={w?.queueDepth ?? 0} icon={Layers} />
        <Widget
          label="Failed 24h"
          value={w?.failedLast24h ?? 0}
          icon={Bell}
          tone={(w?.failedLast24h ?? 0) > 0 ? "red" : undefined}
        />
        <Widget
          label="Last print"
          value={
            w?.lastPrintedAt
              ? new Date(w.lastPrintedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "—"
          }
          icon={PrinterIcon}
        />
      </div>

      {/* Tabs */}
      <div className="border-b border-zinc-200 flex gap-1">
        <TabBtn active={tab === "printers"} onClick={() => setTab("printers")} icon={PrinterIcon}>
          Printers
        </TabBtn>
        <TabBtn active={tab === "stations"} onClick={() => setTab("stations")} icon={Wrench}>
          Stations
        </TabBtn>
        <TabBtn active={tab === "agents"} onClick={() => setTab("agents")} icon={Cpu}>
          Agents
        </TabBtn>
        <TabBtn active={tab === "alerts"} onClick={() => setTab("alerts")} icon={Bell}>
          Alerts &amp; sounds
        </TabBtn>
        <TabBtn active={tab === "automation"} onClick={() => setTab("automation")} icon={Zap}>
          Automation
        </TabBtn>
      </div>

      {tab === "printers" && <PrintersTab locationId={locationId ?? undefined} />}
      {tab === "stations" && <StationsTab locationId={locationId ?? undefined} />}
      {tab === "agents" && <AgentsTab locationId={locationId ?? undefined} />}
      {tab === "alerts" && <AlertsTab locationId={locationId ?? undefined} />}
      {tab === "automation" && <AutomationTab locationId={locationId ?? undefined} />}
    </div>
  );
}

function Widget({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string | number;
  icon: any;
  tone?: "emerald" | "amber" | "red";
}) {
  const toneCls =
    tone === "emerald"
      ? "bg-emerald-50 text-emerald-700"
      : tone === "amber"
        ? "bg-amber-50 text-amber-700"
        : tone === "red"
          ? "bg-red-50 text-red-700"
          : "bg-zinc-50 text-zinc-700";
  return (
    <div className={`rounded-lg border border-zinc-200 ${toneCls} p-3`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide opacity-80">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: any;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
        active
          ? "border-violet-600 text-violet-700"
          : "border-transparent text-zinc-500 hover:text-zinc-700"
      }`}
    >
      <Icon className="h-4 w-4" />
      {children}
    </button>
  );
}
