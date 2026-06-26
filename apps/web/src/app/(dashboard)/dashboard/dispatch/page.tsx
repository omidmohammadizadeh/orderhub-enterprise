"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Truck, Users, Loader2, Send, LayoutDashboard } from "lucide-react";
import { getDispatchFeed, assignOrders } from "@/lib/api/dispatch.client";
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
  presence?: { status: "OFFLINE" | "ONLINE" | "ON_JOB"; locationId: string | null } | null;
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

  const queryClient = useQueryClient();
  async function toggleDriver(driverId: string, online: boolean) {
    try {
      await apiClient.patch(`/v1/drivers/${driverId}/presence`, { online });
      queryClient.invalidateQueries({ queryKey: ["fleet-drivers"] });
      queryClient.invalidateQueries({ queryKey: ["dispatch-feed"] });
    } catch {
      /* ignore */
    }
  }

  const feed = feedQuery.data;
  const locationOptions = optionsQuery.data?.locations ?? [];

  // ── Own-fleet dispatch flow ──────────────────────────────────────────────
  const [chooser, setChooser] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [assigning, setAssigning] = useState(false);

  const onlineDrivers = (feed?.drivers ?? []).filter((d) => d.status === "ONLINE");

  function toggleSelect(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }
  function cancelDispatch() {
    setDispatching(false);
    setChooser(false);
    setSelected([]);
  }
  async function assignTo(driverId: string) {
    if (!selected.length) return;
    setAssigning(true);
    try {
      await assignOrders(driverId, selected);
      cancelDispatch();
      queryClient.invalidateQueries({ queryKey: ["dispatch-feed"] });
      queryClient.invalidateQueries({ queryKey: ["fleet-drivers"] });
    } catch {
      /* ignore */
    } finally {
      setAssigning(false);
    }
  }

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
          <button
            onClick={() => (dispatching ? cancelDispatch() : setChooser((c) => !c))}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            <Send className="h-4 w-4" /> {dispatching ? "Cancel dispatch" : "Dispatch"}
          </button>
          <Link
            href="/dashboard/dispatch/operator"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
          >
            <LayoutDashboard className="h-4 w-4" /> Operator dashboard
          </Link>
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

      {/* Provider chooser */}
      {chooser && !dispatching && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-2 text-sm">
          <span className="text-muted-foreground">Dispatch via:</span>
          <button
            onClick={() => {
              setChooser(false);
              setDispatching(true);
              setSelected([]);
            }}
            className="rounded-md bg-primary px-3 py-1 text-primary-foreground"
          >
            Own fleet
          </button>
          <button disabled className="rounded-md border px-3 py-1 opacity-40">
            Stuart (soon)
          </button>
          <button disabled className="rounded-md border px-3 py-1 opacity-40">
            Uber Direct (soon)
          </button>
          <button onClick={() => setChooser(false)} className="ml-auto text-muted-foreground">
            Cancel
          </button>
        </div>
      )}

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
            <DispatchMap
              feed={feed}
              now={now}
              focusKey={location}
              selecting={dispatching}
              selectedIds={selected}
              onSelectOrder={toggleSelect}
            />

            {/* Driver assignment panel (own fleet) */}
            {dispatching && (
              <div className="absolute right-3 top-3 z-20 w-64 rounded-lg border bg-background p-3 shadow-lg">
                <div className="mb-1 text-sm font-semibold">Assign delivery</div>
                <p className="mb-2 text-xs text-muted-foreground">
                  {selected.length === 0
                    ? "Tap orders on the map in delivery order (1, 2, 3…)."
                    : `${selected.length} stop(s) selected — pick an available driver.`}
                </p>
                <div className="max-h-64 space-y-1 overflow-auto">
                  {onlineDrivers.length === 0 && (
                    <p className="text-xs text-muted-foreground">No available drivers online.</p>
                  )}
                  {onlineDrivers.map((d) => (
                    <button
                      key={d.driverId}
                      disabled={!selected.length || assigning}
                      onClick={() => assignTo(d.driverId)}
                      className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-40"
                    >
                      <span>{d.name}</span>
                      <span className="text-xs text-green-600">● available</span>
                    </button>
                  ))}
                </div>
                <button
                  onClick={cancelDispatch}
                  className="mt-2 w-full rounded-md border px-3 py-1.5 text-sm"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </>
      ) : (
        <FleetTab drivers={fleetQuery.data} loading={fleetQuery.isLoading} onToggle={toggleDriver} />
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

function FleetTab({
  drivers,
  loading,
  onToggle,
}: {
  drivers?: FleetDriver[];
  loading: boolean;
  onToggle: (id: string, online: boolean) => void;
}) {
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
            <th className="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                No drivers yet. Add your fleet to start dispatching.
              </td>
            </tr>
          )}
          {list.map((d) => {
            const status = d.presence?.status ?? "OFFLINE";
            const isOnline = status === "ONLINE" || status === "ON_JOB";
            const label = status === "ON_JOB" ? "On a job" : status === "ONLINE" ? "Online" : "Offline";
            const dot = status === "ON_JOB" ? "#dc2626" : status === "ONLINE" ? "#16a34a" : "#94a3b8";
            return (
              <tr key={d.id} className="border-t">
                <td className="px-4 py-2">{d.name ?? `${d.firstName ?? ""} ${d.lastName ?? ""}`.trim()}</td>
                <td className="px-4 py-2">{d.phone ?? "—"}</td>
                <td className="px-4 py-2">{d.vehicleType ?? "—"}</td>
                <td className="px-4 py-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: dot }} />
                    {label}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    onClick={() => onToggle(d.id, !isOnline)}
                    disabled={status === "ON_JOB"}
                    className={cn(
                      "rounded-md border px-3 py-1 text-xs font-medium",
                      status === "ON_JOB"
                        ? "opacity-40"
                        : isOnline
                          ? "border-red-300 text-red-600 hover:bg-red-50"
                          : "border-green-300 text-green-700 hover:bg-green-50",
                    )}
                    title={status === "ON_JOB" ? "Driver is on a job" : undefined}
                  >
                    {isOnline ? "Set offline" : "Set online"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
