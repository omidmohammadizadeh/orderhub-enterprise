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
import { useQuery } from "@tanstack/react-query";
import {
  Printer as PrinterIcon,
  Wrench,
  Cpu,
  Bell,
  Wifi,
  WifiOff,
  Layers,
  Loader2,
} from "lucide-react";
import {
  printersClient,
  type Widgets,
} from "@/lib/api/printers.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { PrintersTab } from "@/components/printers/printers-tab";
import { StationsTab } from "@/components/printers/stations-tab";
import { AgentsTab } from "@/components/printers/agents-tab";
import { AlertsTab } from "@/components/printers/alerts-tab";

type Tab = "printers" | "stations" | "agents" | "alerts";

export default function PrintersPage() {
  const [tab, setTab] = useState<Tab>("printers");
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);

  const widgetsQuery = useQuery({
    queryKey: ["printers", "widgets", locationId ?? "all"],
    queryFn: () => printersClient.widgets(locationId ?? undefined),
    refetchInterval: 15_000,
  });
  const w: Widgets | undefined = widgetsQuery.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">Printers</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Configure printers, stations, agents, and notification alerts.
        </p>
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
      </div>

      {tab === "printers" && <PrintersTab locationId={locationId ?? undefined} />}
      {tab === "stations" && <StationsTab locationId={locationId ?? undefined} />}
      {tab === "agents" && <AgentsTab locationId={locationId ?? undefined} />}
      {tab === "alerts" && <AlertsTab locationId={locationId ?? undefined} />}
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
