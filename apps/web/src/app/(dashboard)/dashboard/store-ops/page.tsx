"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Power,
  PauseCircle,
  PlayCircle,
  AlertTriangle,
  Clock,
  Zap,
  TrendingUp,
  Settings,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { useAuthStore } from "@/stores/auth.store";
import { cn } from "@/lib/utils";

interface StoreStatus {
  locationId: string;
  name: string;
  isOpen: boolean;
  isPaused: boolean;
  pauseUntil: string | null;
  busyMode: boolean;
  currentPrepTime: number;
  throttleLimit: number | null;
  storeStatusNote: string | null;
  effectivelyOpen: boolean;
  minutesUntilResume: number | null;
}

const PAUSE_PRESETS = [
  { label: "15 min", value: 15 },
  { label: "30 min", value: 30 },
  { label: "1 hour", value: 60 },
  { label: "2 hours", value: 120 },
];

const PREP_PRESETS = [10, 15, 20, 25, 30, 45, 60];

export default function StoreOpsPage() {
  const { user } = useAuthStore();
  const qc = useQueryClient();
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [pauseMinutes, setPauseMinutes] = useState(30);
  const [customPauseInput, setCustomPauseInput] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [showEmergencyConfirm, setShowEmergencyConfirm] = useState(false);

  const { data: locations, isLoading: locLoading } = useQuery({
    queryKey: ["locations", user?.defaultLocationId],
    queryFn: () =>
      user?.brandId
        ? apiClient.get(`/v1/store-ops/brand/${user.brandId}`).then((r) => r.data as StoreStatus[])
        : Promise.resolve([]),
    enabled: !!user?.brandId,
    refetchInterval: 30_000,
  });

  const activeLocation = locations?.find((l) => l.locationId === selectedLocationId) ?? locations?.[0];

  useEffect(() => {
    if (locations?.length && !selectedLocationId && locations[0]) {
      setSelectedLocationId(locations[0].locationId);
    }
  }, [locations, selectedLocationId]);

  const mutation = useMutation({
    mutationFn: (dto: Record<string, unknown>) =>
      apiClient
        .patch(`/v1/store-ops/${activeLocation?.locationId}`, dto)
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["locations"] }),
  });

  const emergencyMutation = useMutation({
    mutationFn: (reason: string) =>
      apiClient
        .post(`/v1/store-ops/${activeLocation?.locationId}/emergency-close`, { reason })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["locations"] });
      setShowEmergencyConfirm(false);
    },
  });

  const resumeMutation = useMutation({
    mutationFn: () =>
      apiClient.post(`/v1/store-ops/${activeLocation?.locationId}/resume`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["locations"] }),
  });

  if (locLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (!activeLocation) {
    return (
      <div className="text-center py-16 text-zinc-500">
        No locations found. Set up a location in the onboarding guide.
      </div>
    );
  }

  const isPending =
    mutation.isPending || emergencyMutation.isPending || resumeMutation.isPending;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Store Operations</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Control live store status and ordering availability</p>
        </div>
        {locations && locations.length > 1 && (
          <select
            value={selectedLocationId ?? ""}
            onChange={(e) => setSelectedLocationId(e.target.value)}
            className="text-sm border border-zinc-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
          >
            {locations.map((l) => (
              <option key={l.locationId} value={l.locationId}>{l.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Status hero card */}
      <div
        className={cn(
          "rounded-2xl p-6 border-2 transition-colors",
          activeLocation.effectivelyOpen
            ? "bg-emerald-50 border-emerald-200"
            : activeLocation.isPaused
            ? "bg-amber-50 border-amber-200"
            : "bg-red-50 border-red-200",
        )}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div
              className={cn(
                "w-16 h-16 rounded-full flex items-center justify-center",
                activeLocation.effectivelyOpen
                  ? "bg-emerald-500"
                  : activeLocation.isPaused
                  ? "bg-amber-500"
                  : "bg-red-500",
              )}
            >
              {activeLocation.effectivelyOpen ? (
                <CheckCircle2 className="w-8 h-8 text-white" />
              ) : activeLocation.isPaused ? (
                <PauseCircle className="w-8 h-8 text-white" />
              ) : (
                <XCircle className="w-8 h-8 text-white" />
              )}
            </div>
            <div>
              <div className="text-2xl font-bold text-zinc-900">
                {activeLocation.effectivelyOpen
                  ? "Open for orders"
                  : activeLocation.isPaused
                  ? "Paused"
                  : "Closed"}
              </div>
              <div className="text-sm text-zinc-600 mt-0.5">
                {activeLocation.name}
                {activeLocation.isPaused && activeLocation.minutesUntilResume !== null && (
                  <span className="ml-2 text-amber-700 font-medium">
                    · Resumes in {activeLocation.minutesUntilResume} min
                  </span>
                )}
              </div>
              {activeLocation.storeStatusNote && (
                <div className="text-sm text-zinc-500 mt-1 italic">
                  &ldquo;{activeLocation.storeStatusNote}&rdquo;
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {activeLocation.effectivelyOpen ? (
              <button
                onClick={() => mutation.mutate({ isOpen: false })}
                disabled={isPending}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 disabled:opacity-50 text-sm font-medium transition-colors"
              >
                <Power className="w-4 h-4" />
                Close store
              </button>
            ) : (
              <button
                onClick={() => resumeMutation.mutate()}
                disabled={isPending}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 text-sm font-medium transition-colors"
              >
                <PlayCircle className="w-4 h-4" />
                Open store
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Pause controls */}
        <div className="bg-white border border-zinc-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <PauseCircle className="w-5 h-5 text-amber-500" />
            <h2 className="font-medium text-zinc-900">Pause new orders</h2>
          </div>
          <p className="text-sm text-zinc-500">
            Temporarily stop accepting orders. Orders in progress continue unaffected.
          </p>
          <div className="flex flex-wrap gap-2">
            {PAUSE_PRESETS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPauseMinutes(p.value)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors",
                  pauseMinutes === p.value
                    ? "bg-amber-500 text-white border-amber-500"
                    : "border-zinc-200 text-zinc-700 hover:border-amber-300",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={statusNote}
              onChange={(e) => setStatusNote(e.target.value)}
              placeholder="Note for customers (optional)"
              className="flex-1 text-sm border border-zinc-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </div>
          <div className="flex gap-2">
            {activeLocation.isPaused ? (
              <button
                onClick={() => resumeMutation.mutate()}
                disabled={isPending}
                className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 text-sm font-medium"
              >
                <PlayCircle className="w-4 h-4" />
                Resume now
              </button>
            ) : (
              <button
                onClick={() =>
                  mutation.mutate({
                    pauseMinutes,
                    storeStatusNote: statusNote || null,
                  })
                }
                disabled={isPending || !activeLocation.isOpen}
                className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 text-sm font-medium"
              >
                <PauseCircle className="w-4 h-4" />
                Pause for {pauseMinutes} min
              </button>
            )}
          </div>
        </div>

        {/* Prep time */}
        <div className="bg-white border border-zinc-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-blue-500" />
            <h2 className="font-medium text-zinc-900">Quoted prep time</h2>
          </div>
          <p className="text-sm text-zinc-500">
            Time shown to customers when ordering. Currently{" "}
            <strong>{activeLocation.currentPrepTime} minutes</strong>.
          </p>
          <div className="flex flex-wrap gap-2">
            {PREP_PRESETS.map((m) => (
              <button
                key={m}
                onClick={() => mutation.mutate({ currentPrepTime: m })}
                disabled={isPending}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors",
                  activeLocation.currentPrepTime === m
                    ? "bg-blue-500 text-white border-blue-500"
                    : "border-zinc-200 text-zinc-700 hover:border-blue-300",
                )}
              >
                {m} min
              </button>
            ))}
          </div>
        </div>

        {/* Busy mode */}
        <div className="bg-white border border-zinc-200 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-orange-500" />
            <h2 className="font-medium text-zinc-900">Busy mode</h2>
          </div>
          <p className="text-sm text-zinc-500">
            Signal to customers that the kitchen is busy. Extends displayed wait times.
          </p>
          <button
            onClick={() => mutation.mutate({ busyMode: !activeLocation.busyMode })}
            disabled={isPending}
            className={cn(
              "w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors",
              activeLocation.busyMode
                ? "bg-orange-100 text-orange-700 border border-orange-300 hover:bg-orange-200"
                : "bg-zinc-100 text-zinc-700 border border-zinc-200 hover:bg-zinc-200",
            )}
          >
            <Zap className="w-4 h-4" />
            {activeLocation.busyMode ? "Busy mode ON — click to disable" : "Enable busy mode"}
          </button>
        </div>

        {/* Order throttle */}
        <div className="bg-white border border-zinc-200 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-purple-500" />
            <h2 className="font-medium text-zinc-900">Order throttle</h2>
          </div>
          <p className="text-sm text-zinc-500">
            Limit the maximum number of new orders per hour.{" "}
            {activeLocation.throttleLimit
              ? `Currently capped at ${activeLocation.throttleLimit}/hour.`
              : "No limit set."}
          </p>
          <div className="flex gap-2">
            {[null, 10, 20, 30, 50].map((limit) => (
              <button
                key={String(limit)}
                onClick={() => mutation.mutate({ throttleLimit: limit })}
                disabled={isPending}
                className={cn(
                  "flex-1 px-2 py-1.5 rounded-lg text-xs font-medium border transition-colors",
                  activeLocation.throttleLimit === limit
                    ? "bg-purple-500 text-white border-purple-500"
                    : "border-zinc-200 text-zinc-700 hover:border-purple-300",
                )}
              >
                {limit === null ? "Off" : `${limit}/hr`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Emergency close */}
      <div className="bg-red-50 border border-red-200 rounded-xl p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600" />
            <div>
              <div className="font-medium text-zinc-900">Emergency close</div>
              <div className="text-sm text-zinc-500">
                Immediately close the store across all platforms. Cannot be undone automatically.
              </div>
            </div>
          </div>
          {!showEmergencyConfirm ? (
            <button
              onClick={() => setShowEmergencyConfirm(true)}
              className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 text-sm font-medium"
            >
              Emergency close
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-red-700 font-medium">Are you sure?</span>
              <button
                onClick={() => emergencyMutation.mutate("Emergency close triggered by manager")}
                disabled={isPending}
                className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                Confirm
              </button>
              <button
                onClick={() => setShowEmergencyConfirm(false)}
                className="px-3 py-1.5 rounded-lg border border-zinc-300 text-sm font-medium"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
