"use client";

// Phase KD — Kitchen Display launcher (sidebar → Kitchen Display).
//
// Pick a station to open its fullscreen display (/kds?screen=<id>).
// Tiles show live open-ticket counts; screens are managed under
// Settings → Kitchen screens.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ChefHat, Monitor, Settings, ExternalLink, Flame } from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { locationsClient } from "@/lib/api/locations.client";
import { cn } from "@/lib/utils";

interface KdsScreen {
  id: string;
  name: string;
  station: string;
  isActive: boolean;
  settings: {
    stationType?: "STATION" | "EXPO";
    categoryIds?: string[];
    itemIds?: string[];
    channels?: string[];
    slaWarnMinutes?: number;
    slaLateMinutes?: number;
  } | null;
  _count?: { tickets: number };
}

export default function KitchenLauncherPage() {
  const router = useRouter();
  const { data: locations = [] } = useQuery({
    queryKey: ["locations"],
    queryFn: locationsClient.list,
  });
  const [locationId, setLocationId] = useState("");

  // Until the operator picks a location, default to the first one that
  // actually has active screens (a tenant's first location is often an
  // empty shell like "Main Location").
  const { data: screensByLocation = {} } = useQuery<Record<string, number>>({
    queryKey: ["kds-screen-counts", (locations as any[]).map((l) => l.id).join(",")],
    queryFn: async () => {
      const counts: Record<string, number> = {};
      await Promise.all(
        (locations as any[]).map(async (l) => {
          try {
            const r = await apiClient.get(`/v1/kds/screens?locationId=${l.id}`);
            counts[l.id] = (r.data as any[]).filter((s) => s.isActive).length;
          } catch {
            counts[l.id] = 0;
          }
        }),
      );
      return counts;
    },
    enabled: locations.length > 0,
    staleTime: 30_000,
  });
  const defaultLocation =
    (locations as any[]).find((l) => (screensByLocation[l.id] ?? 0) > 0)?.id ||
    (locations[0] as any)?.id ||
    "";
  const location = locationId || defaultLocation;

  const { data: screens = [], isLoading } = useQuery<KdsScreen[]>({
    queryKey: ["kds-screens", location],
    queryFn: () =>
      apiClient
        .get(`/v1/kds/screens?locationId=${location}`)
        .then((r) => r.data),
    enabled: !!location,
    refetchInterval: 15_000,
  });

  const active = screens.filter((s) => s.isActive);

  return (
    <div className="px-6 py-6 max-w-5xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 flex items-center gap-2">
            <ChefHat className="h-5 w-5" /> Kitchen Display
          </h1>
          <p className="text-sm text-zinc-500 mt-1">
            Pick a station to open its fullscreen display — run it on any
            tablet at the pass. Orders appear the moment they're accepted.
          </p>
        </div>
        <button
          onClick={() => router.push("/dashboard/settings/kitchen")}
          className="inline-flex items-center gap-2 rounded-md border border-zinc-300 px-3.5 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          <Settings className="h-4 w-4" /> Manage screens
        </button>
      </div>

      {locations.length > 1 && (
        <select
          value={location}
          onChange={(e) => setLocationId(e.target.value)}
          className="mb-5 rounded-md border border-zinc-300 px-3 py-2 text-sm"
        >
          {(locations as any[]).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      )}

      {isLoading ? (
        <p className="text-sm text-zinc-400 py-10">Loading…</p>
      ) : active.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-zinc-200 px-6 py-16 text-center">
          <Monitor className="h-10 w-10 mx-auto text-zinc-300 mb-3" />
          <p className="font-medium text-zinc-500">No kitchen screens yet</p>
          <p className="text-sm text-zinc-400 mt-1 mb-4">
            Create your first screen — start with one named "Kitchen" that
            shows every item.
          </p>
          <button
            onClick={() => router.push("/dashboard/settings/kitchen")}
            className="inline-flex items-center gap-2 rounded-md bg-zinc-900 text-white px-4 py-2 text-sm font-semibold hover:bg-zinc-800"
          >
            <Settings className="h-4 w-4" /> Set up screens
          </button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {active.map((s) => {
            const st = s.settings ?? {};
            const open = s._count?.tickets ?? 0;
            const isExpo = st.stationType === "EXPO";
            return (
              <button
                key={s.id}
                onClick={() => router.push(`/kds?screen=${s.id}`)}
                className={cn(
                  "group relative rounded-2xl border-2 p-5 text-left transition-all hover:-translate-y-0.5",
                  isExpo
                    ? "border-violet-200 bg-violet-50/40 hover:border-violet-400"
                    : "border-zinc-200 bg-white hover:border-emerald-400",
                )}
              >
                <div className="flex items-start justify-between mb-6">
                  <div
                    className={cn(
                      "h-11 w-11 rounded-xl flex items-center justify-center",
                      isExpo
                        ? "bg-violet-100 text-violet-600"
                        : "bg-emerald-100 text-emerald-700",
                    )}
                  >
                    {isExpo ? (
                      <Monitor className="h-5 w-5" />
                    ) : (
                      <Flame className="h-5 w-5" />
                    )}
                  </div>
                  <span
                    className={cn(
                      "rounded-full px-2.5 py-1 text-xs font-bold",
                      open > 0
                        ? "bg-amber-100 text-amber-800"
                        : "bg-zinc-100 text-zinc-500",
                    )}
                  >
                    {open} open
                  </span>
                </div>
                <p className="text-lg font-semibold text-zinc-900">{s.name}</p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {isExpo
                    ? "Expo — whole orders, serves them"
                    : st.categoryIds?.length || st.itemIds?.length
                      ? `Station — ${[
                          st.categoryIds?.length
                            ? `${st.categoryIds.length} categories`
                            : null,
                          st.itemIds?.length
                            ? `${st.itemIds.length} items`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" + ")}`
                      : "Station — every item"}
                </p>
                <p className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700 group-hover:text-emerald-800">
                  Open display <ExternalLink className="h-3.5 w-3.5" />
                </p>
              </button>
            );
          })}
        </div>
      )}

      <p className="text-xs text-zinc-400 mt-6">
        Tip: on a kitchen tablet, open a station and add it to the home screen
        (or bookmark it) — the URL keeps the station selected, and the display
        goes fullscreen from the expand icon in its header.
      </p>
    </div>
  );
}
