"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Truck, Users, Loader2 } from "lucide-react";
import { getDispatchFeed } from "@/lib/api/dispatch.client";
import { apiClient } from "@/lib/api/client";
import { DispatchMap } from "@/components/dispatch/dispatch-map";
import { cn } from "@/lib/utils";

interface FleetDriver {
  id: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  phone: string | null;
  vehicleType: string | null;
  isActive: boolean;
}

export default function DispatchPage() {
  const [tab, setTab] = useState<"map" | "fleet">("map");
  const [location, setLocation] = useState<string>("all");
  const [now, setNow] = useState<number>(Date.now());

  // 1s clock drives the countdown labels + pin colours.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const feedQuery = useQuery({
    queryKey: ["dispatch-feed", location],
    queryFn: () => getDispatchFeed(location),
    refetchInterval: 10_000,
  });

  // Stable list of accessible locations for the scope selector.
  const optionsQuery = useQuery({
    queryKey: ["dispatch-locations"],
    queryFn: () => getDispatchFeed("all"),
    staleTime: 60_000,
  });

  const fleetQuery = useQuery({
    queryKey: ["fleet-drivers"],
    queryFn: () => apiClient.get<FleetDriver[]>("/v1/drivers").then((r) => r.data),
    enabled: tab === "fleet",
  });

  const feed = feedQuery.data;
  const locationOptions = optionsQuery.data?.locations ?? [];

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Dispatch</h1>
          <p className="text-sm text-muted-foreground">
            Live delivery map — orders, drivers and countdowns in real time.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            <option value="all">All locations</option>
            {locationOptions.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <div className="flex rounded-md border p-0.5">
            <button
              onClick={() => setTab("map")}
              className={cn(
                "rounded px-3 py-1 text-sm",
                tab === "map" ? "bg-primary text-primary-foreground" : "text-muted-foreground",
              )}
            >
              Map
            </button>
            <button
              onClick={() => setTab("fleet")}
              className={cn(
                "rounded px-3 py-1 text-sm",
                tab === "fleet" ? "bg-primary text-primary-foreground" : "text-muted-foreground",
              )}
            >
              Fleet
            </button>
          </div>
        </div>
      </div>

      {tab === "map" ? (
        <>
          {/* Stat strip + legend */}
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="h-4 w-4 text-violet-600" /> {feed?.locations.length ?? 0} location(s)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Truck className="h-4 w-4 text-blue-600" /> {feed?.orders.length ?? 0} live order(s)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Users className="h-4 w-4 text-amber-600" /> {feed?.drivers.length ?? 0} driver(s) online
            </span>
            <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
              <Legend color="#16a34a" label="On time" />
              <Legend color="#f97316" label="Due soon" />
              <Legend color="#dc2626" label="Overdue" />
            </span>
          </div>

          <div className="relative min-h-[60vh] flex-1 overflow-hidden rounded-lg border">
            {feedQuery.isLoading && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}
            {feedQuery.isError && (
              <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-red-600">
                Failed to load dispatch feed.
              </div>
            )}
            <DispatchMap feed={feed} now={now} />
          </div>
        </>
      ) : (
        <FleetTab drivers={fleetQuery.data} loading={fleetQuery.isLoading} />
      )}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function FleetTab({ drivers, loading }: { drivers?: FleetDriver[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const list = drivers ?? [];
  return (
    <div className="flex-1 overflow-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-4 py-2">Driver</th>
            <th className="px-4 py-2">Phone</th>
            <th className="px-4 py-2">Vehicle</th>
            <th className="px-4 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                No drivers yet. Add your fleet to start dispatching.
              </td>
            </tr>
          )}
          {list.map((d) => (
            <tr key={d.id} className="border-t">
              <td className="px-4 py-2">{d.name ?? `${d.firstName ?? ""} ${d.lastName ?? ""}`.trim()}</td>
              <td className="px-4 py-2">{d.phone ?? "—"}</td>
              <td className="px-4 py-2">{d.vehicleType ?? "—"}</td>
              <td className="px-4 py-2">{d.isActive ? "Active" : "Inactive"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
