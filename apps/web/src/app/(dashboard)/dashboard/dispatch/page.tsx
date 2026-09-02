"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Truck, Users, Loader2, Send, LayoutDashboard } from "lucide-react";
import { getDispatchFeed, assignOrders } from "@/lib/api/dispatch.client";
import { apiClient } from "@/lib/api/client";
import { DispatchMap } from "@/components/dispatch/dispatch-map";
import { DispatchChatWidget } from "@/components/dispatch/chat-widget";
import { cn } from "@/lib/utils";

interface FleetDriver {
  id: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  phone: string | null;
  vehicleType: string | null;
  isActive: boolean;
  // Phase BG home location. No longer read for scoping — a driver's shops
  // come from their Team Roles assignment, which the API resolves and returns
  // as locationNames.
  locationId?: string | null;
  locationNames?: string[];
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
    // Same shop scope as the map. "all" means every location this user can
    // reach, which the API resolves from their own assignments — never the
    // whole tenant.
    queryKey: ["fleet-drivers", location],
    queryFn: () =>
      apiClient
        .get<FleetDriver[]>("/v1/drivers", {
          params: location === "all" ? undefined : { locationId: location },
        })
        .then((r) => r.data),
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
  // Location scoping: a user with one accessible location is pinned to it (no
  // "All locations"); multi-location users get the picker + an "All" view.
  const multiLocation = locationOptions.length > 1;
  useEffect(() => {
    if (!multiLocation && locationOptions[0] && location === "all") {
      setLocation(locationOptions[0].id);
    }
  }, [multiLocation, locationOptions, location]);

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
          {multiLocation ? (
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
          ) : locationOptions[0] ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-sm">
              <MapPin className="h-3.5 w-3.5 text-violet-600" /> {locationOptions[0].name}
            </span>
          ) : null}
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
          <span className="text-xs text-muted-foreground">
            Stuart &amp; Uber Direct are dispatched per order (with a live price)
            — open an order and tap <strong>Dispatch</strong>.
          </span>
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
              <div className="absolute right-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-72 flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white text-neutral-900 shadow-2xl ring-1 ring-black/5 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
                <div className="border-b border-neutral-200 px-4 py-3 dark:border-neutral-700">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Send className="h-4 w-4 text-primary" /> Assign delivery
                  </div>
                  <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    {selected.length === 0
                      ? "Tap order houses on the map in delivery order (1, 2, 3…)."
                      : `${selected.length} stop${selected.length > 1 ? "s" : ""} selected — pick an available driver.`}
                  </p>
                </div>
                <div className="flex-1 space-y-1.5 overflow-auto p-2">
                  {onlineDrivers.length === 0 && (
                    <div className="px-2 py-6 text-center text-xs text-neutral-500 dark:text-neutral-400">
                      No drivers online right now.
                    </div>
                  )}
                  {onlineDrivers.map((d) => {
                    const initials = d.name
                      .split(" ")
                      .map((p) => p[0])
                      .filter(Boolean)
                      .slice(0, 2)
                      .join("")
                      .toUpperCase();
                    return (
                      <button
                        key={d.driverId}
                        disabled={!selected.length || assigning}
                        onClick={() => assignTo(d.driverId)}
                        className="flex w-full items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-left text-sm transition hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-800 dark:hover:bg-neutral-700/60"
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                          {initials || "?"}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-medium">{d.name}</span>
                          <span className="inline-flex items-center gap-1 text-xs text-green-600">
                            <span className="h-1.5 w-1.5 rounded-full bg-green-500" /> Available
                          </span>
                        </span>
                        <span className="text-xs font-medium text-primary">Assign ›</span>
                      </button>
                    );
                  })}
                </div>
                <div className="border-t border-neutral-200 p-2 dark:border-neutral-700">
                  <button
                    onClick={cancelDispatch}
                    className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-600 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <FleetTab
          drivers={fleetQuery.data}
          loading={fleetQuery.isLoading}
          onToggle={toggleDriver}
        />
      )}

      {/* Floating driver chat — same shop scope as the map and fleet above.
          "all" means every location this user can reach, which the API
          resolves from their own assignments rather than the tenant. */}
      <DispatchChatWidget
        locationId={location === "all" ? undefined : location}
      />
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
            <th className="px-4 py-2">Location</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
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
                {/* Read-only. This used to be a second place to say where a
                    driver works, and the two never agreed: giving somebody the
                    DRIVER role and their shops on Team Roles left them off
                    that shop's map until an operator came here and picked it
                    again, with nothing on either screen saying so. Team Roles
                    is the one answer now; this shows it. */}
                <td className="px-4 py-2 text-xs">
                  {d.locationNames?.length ? (
                    d.locationNames.join(", ")
                  ) : (
                    <span
                      className="text-amber-600"
                      title="Set this driver's shops on the Team Roles tab."
                    >
                      No shop — set on Team Roles
                    </span>
                  )}
                </td>
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
