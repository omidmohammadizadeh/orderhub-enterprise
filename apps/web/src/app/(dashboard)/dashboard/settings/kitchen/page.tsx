"use client";

// Phase KD — kitchen screens management.
//
// Create/edit the location's KDS screens: station name + type
// (STATION/EXPO), category routing, channel filter and SLA thresholds.
// The display itself lives at /kds?screen=<id> (fullscreen, tablet).

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient, useQueries } from "@tanstack/react-query";
import {
  Monitor,
  Plus,
  Trash2,
  ExternalLink,
  Pencil,
  X,
} from "lucide-react";
import toast from "react-hot-toast";
import { apiClient } from "@/lib/api/client";
import { locationsClient } from "@/lib/api/locations.client";
import { menusClient } from "@/lib/api/menus.client";
import { cn } from "@/lib/utils";

interface KdsScreenSettings {
  stationType?: "STATION" | "EXPO";
  categoryIds?: string[];
  channels?: string[];
  slaWarnMinutes?: number;
  slaLateMinutes?: number;
}

interface KdsScreen {
  id: string;
  name: string;
  station: string;
  isActive: boolean;
  settings: KdsScreenSettings | null;
  _count?: { tickets: number };
}

const CHANNELS = [
  ["ONLINE", "Online"],
  ["POS", "POS"],
  ["UBER_EATS", "Uber Eats"],
  ["DELIVEROO", "Deliveroo"],
  ["JUST_EAT", "Just Eat"],
  ["WHATSAPP", "WhatsApp"],
  ["HUBRISE", "Marketplace"],
] as const;

export default function KitchenScreensPage() {
  const qc = useQueryClient();
  const { data: locations = [] } = useQuery({
    queryKey: ["locations"],
    queryFn: locationsClient.list,
  });
  const [locationId, setLocationId] = useState("");
  const location = locationId || (locations[0] as any)?.id || "";

  const { data: screens = [], isLoading } = useQuery<KdsScreen[]>({
    queryKey: ["kds-screens", location],
    queryFn: () =>
      apiClient.get(`/v1/kds/screens?locationId=${location}`).then((r) => r.data),
    enabled: !!location,
  });

  // Categories across the location's menus — the routing vocabulary.
  const { data: menus = [] } = useQuery({
    queryKey: ["kds-menus", location],
    queryFn: () => menusClient.listMenusForLocation(location),
    enabled: !!location,
  });
  const menuDetails = useQueries({
    queries: (menus as any[]).map((m) => ({
      queryKey: ["kds-menu", m.id],
      queryFn: () => menusClient.getMenu(m.id),
      staleTime: 60_000,
    })),
  });
  const categories = useMemo(() => {
    const out: Array<{ id: string; label: string }> = [];
    for (const q of menuDetails) {
      const menu: any = q.data;
      if (!menu) continue;
      for (const c of menu.categories ?? []) {
        out.push({
          id: c.id,
          label:
            (menus as any[]).length > 1 ? `${menu.name} · ${c.name}` : c.name,
        });
      }
    }
    return out;
  }, [menuDetails, menus]);

  const [editing, setEditing] = useState<KdsScreen | "new" | null>(null);

  const removeMutation = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/v1/kds/screens/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["kds-screens", location] });
      toast.success("Screen removed");
    },
  });
  const toggleMutation = useMutation({
    mutationFn: (s: KdsScreen) =>
      apiClient.patch(`/v1/kds/screens/${s.id}`, { isActive: !s.isActive }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ["kds-screens", location] }),
  });

  return (
    <div className="px-6 py-6 max-w-4xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 flex items-center gap-2">
            <Monitor className="h-5 w-5" /> Kitchen screens
          </h1>
          <p className="text-sm text-zinc-500 mt-1">
            Stations split orders by category (Grill, Fryer, Pizza…); an Expo
            screen sees whole orders and serves them. Open a screen fullscreen
            on any tablet.
          </p>
        </div>
        <button
          onClick={() => setEditing("new")}
          className="inline-flex items-center gap-2 rounded-md bg-zinc-900 text-white px-4 py-2 text-sm font-semibold hover:bg-zinc-800"
        >
          <Plus className="h-4 w-4" /> New screen
        </button>
      </div>

      {locations.length > 1 && (
        <select
          value={location}
          onChange={(e) => setLocationId(e.target.value)}
          className="mb-4 rounded-md border border-zinc-300 px-3 py-2 text-sm"
        >
          {(locations as any[]).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      )}

      {isLoading ? (
        <p className="text-sm text-zinc-400 py-8">Loading…</p>
      ) : screens.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-zinc-200 px-6 py-14 text-center">
          <Monitor className="h-10 w-10 mx-auto text-zinc-300 mb-3" />
          <p className="font-medium text-zinc-500">No screens yet</p>
          <p className="text-sm text-zinc-400 mt-1">
            Start with one screen named "Kitchen" — add stations later if the
            kitchen splits work.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-white divide-y divide-zinc-100">
          {screens.map((s) => {
            const st = s.settings ?? {};
            return (
              <div key={s.id} className="flex items-center gap-4 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-zinc-900">
                    {s.name}
                    <span
                      className={cn(
                        "ml-2 text-[11px] font-semibold px-1.5 py-0.5 rounded",
                        st.stationType === "EXPO"
                          ? "bg-violet-50 text-violet-700"
                          : "bg-zinc-100 text-zinc-600",
                      )}
                    >
                      {st.stationType === "EXPO" ? "Expo" : "Station"}
                    </span>
                    {!s.isActive && (
                      <span className="ml-2 text-[11px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                        Off
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-zinc-500 mt-0.5 truncate">
                    {st.categoryIds?.length
                      ? `${st.categoryIds.length} categories routed`
                      : "Shows every item"}
                    {st.channels?.length
                      ? ` · ${st.channels.length} channels`
                      : " · all channels"}
                    {` · SLA ${st.slaWarnMinutes ?? 5}/${st.slaLateMinutes ?? 10} min`}
                  </p>
                </div>
                <a
                  href={`/kds?screen=${s.id}`}
                  target="_blank"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 hover:text-emerald-800"
                >
                  Open display <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <button
                  onClick={() => toggleMutation.mutate(s)}
                  className={cn(
                    "text-xs font-semibold px-2.5 py-1.5 rounded-md",
                    s.isActive
                      ? "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                      : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100",
                  )}
                >
                  {s.isActive ? "Disable" : "Enable"}
                </button>
                <button
                  onClick={() => setEditing(s)}
                  className="p-1.5 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`Delete screen "${s.name}"?`))
                      removeMutation.mutate(s.id);
                  }}
                  className="p-1.5 rounded text-zinc-400 hover:text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <ScreenForm
          locationId={location}
          categories={categories}
          screen={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ["kds-screens", location] });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ── Create / edit modal ──────────────────────────────────────────────────────

function ScreenForm({
  locationId,
  categories,
  screen,
  onClose,
  onSaved,
}: {
  locationId: string;
  categories: Array<{ id: string; label: string }>;
  screen: KdsScreen | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const st = screen?.settings ?? {};
  const [name, setName] = useState(screen?.name ?? "");
  const [stationType, setStationType] = useState<"STATION" | "EXPO">(
    st.stationType ?? "STATION",
  );
  const [categoryIds, setCategoryIds] = useState<string[]>(
    st.categoryIds ?? [],
  );
  const [channels, setChannels] = useState<string[]>(st.channels ?? []);
  const [warn, setWarn] = useState(st.slaWarnMinutes ?? 5);
  const [late, setLate] = useState(st.slaLateMinutes ?? 10);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const settings: KdsScreenSettings = {
        stationType,
        categoryIds: stationType === "EXPO" ? [] : categoryIds,
        channels,
        slaWarnMinutes: warn,
        slaLateMinutes: late,
      };
      if (screen) {
        await apiClient.patch(`/v1/kds/screens/${screen.id}`, {
          name,
          station: name,
          settings,
        });
      } else {
        await apiClient.post(`/v1/kds/screens?locationId=${locationId}`, {
          name,
          station: name,
          settings,
        });
      }
    },
    onSuccess: () => {
      toast.success(screen ? "Screen updated" : "Screen created");
      onSaved();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Failed to save"),
  });

  const toggle = (arr: string[], v: string, set: (x: string[]) => void) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-sm py-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-xl mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-zinc-900">
            {screen ? "Edit screen" : "New kitchen screen"}
          </h2>
          <button onClick={onClose} className="p-1 text-zinc-400 hover:text-zinc-700">
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="block text-xs font-semibold text-zinc-600 mb-1">
          Screen name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Grill · Fryer · Pizza · Expo…"
          className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm mb-4"
        />

        <label className="block text-xs font-semibold text-zinc-600 mb-1">
          Type
        </label>
        <div className="flex gap-2 mb-4">
          {(
            [
              ["STATION", "Station — cooks a subset of items"],
              ["EXPO", "Expo — sees whole orders, serves them"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setStationType(v)}
              className={cn(
                "flex-1 rounded-lg border px-3 py-2.5 text-left text-xs font-medium",
                stationType === v
                  ? "border-emerald-600 bg-emerald-50 text-emerald-900"
                  : "border-zinc-200 text-zinc-600 hover:border-zinc-300",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {stationType === "STATION" && (
          <>
            <label className="block text-xs font-semibold text-zinc-600 mb-1">
              Route these categories here{" "}
              <span className="font-normal text-zinc-400">
                (none selected = every item)
              </span>
            </label>
            <div className="max-h-40 overflow-y-auto rounded-md border border-zinc-200 p-2 mb-4 grid grid-cols-2 gap-1">
              {categories.length === 0 && (
                <p className="text-xs text-zinc-400 col-span-2 p-1">
                  No menu categories found for this location.
                </p>
              )}
              {categories.map((c) => (
                <label
                  key={c.id}
                  className="flex items-center gap-2 text-xs text-zinc-700 rounded px-1.5 py-1 hover:bg-zinc-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={categoryIds.includes(c.id)}
                    onChange={() => toggle(categoryIds, c.id, setCategoryIds)}
                  />
                  <span className="truncate">{c.label}</span>
                </label>
              ))}
            </div>
          </>
        )}

        <label className="block text-xs font-semibold text-zinc-600 mb-1">
          Channels{" "}
          <span className="font-normal text-zinc-400">
            (none selected = all channels)
          </span>
        </label>
        <div className="flex flex-wrap gap-1.5 mb-4">
          {CHANNELS.map(([v, label]) => (
            <button
              key={v}
              onClick={() => toggle(channels, v, setChannels)}
              className={cn(
                "text-xs font-medium px-2.5 py-1.5 rounded-md border",
                channels.includes(v)
                  ? "border-emerald-600 bg-emerald-50 text-emerald-800"
                  : "border-zinc-200 text-zinc-500 hover:border-zinc-300",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 mb-6">
          <div>
            <label className="block text-xs font-semibold text-zinc-600 mb-1">
              Amber after (minutes)
            </label>
            <input
              type="number"
              min={1}
              value={warn}
              onChange={(e) => setWarn(Number(e.target.value) || 5)}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-zinc-600 mb-1">
              Red after (minutes)
            </label>
            <input
              type="number"
              min={2}
              value={late}
              onChange={(e) => setLate(Number(e.target.value) || 10)}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
          >
            Cancel
          </button>
          <button
            disabled={!name.trim() || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
            className="rounded-md bg-zinc-900 text-white px-4 py-2 text-sm font-semibold hover:bg-zinc-800 disabled:opacity-50"
          >
            {screen ? "Save changes" : "Create screen"}
          </button>
        </div>
      </div>
    </div>
  );
}
