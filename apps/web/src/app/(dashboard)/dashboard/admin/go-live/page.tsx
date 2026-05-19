"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  RefreshCw,
  ChevronRight,
  Rocket,
  Pause,
  Ban,
  MapPin,
  Wifi,
  WifiOff,
  Printer,
  Plug,
  ShoppingBag,
  Users,
  Shield,
  Loader2,
} from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface LocationSummary {
  locationId: string;
  locationName: string;
  tenantId: string;
  brandName: string;
  goLiveStatus: string;
  isActive: boolean;
  score: number | null;
}

interface ReadinessCheck {
  key: string;
  label: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail?: string;
  critical: boolean;
  adminOverridable: boolean;
}

interface ProviderReadiness {
  platform: string;
  connected: boolean;
  credentialsEncrypted: boolean;
  webhookConfigured: boolean;
  lastSuccessfulWebhookAt: string | null;
  integrationStatus: string;
}

interface PrinterReadiness {
  printerId: string;
  printerName: string;
  isActive: boolean;
  isOnline: boolean;
  connectionType: string;
  ready: boolean;
  failedJobsLast24h: number;
}

interface LocationReadiness {
  locationId: string;
  locationName: string;
  tenantId: string;
  goLiveStatus: string;
  score: number;
  blockers: ReadinessCheck[];
  warnings: ReadinessCheck[];
  providers: ProviderReadiness[];
  printers: PrinterReadiness[];
  allChecks: ReadinessCheck[];
  lastUpdated: string;
}

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  DRAFT:             "bg-gray-100 text-gray-600",
  CONFIGURING:       "bg-blue-100 text-blue-700",
  TESTING:           "bg-yellow-100 text-yellow-700",
  READY_FOR_GO_LIVE: "bg-emerald-100 text-emerald-700",
  LIVE:              "bg-green-100 text-green-700",
  PAUSED:            "bg-orange-100 text-orange-700",
  BLOCKED:           "bg-red-100 text-red-700",
};

const NEXT_TRANSITIONS: Record<string, string[]> = {
  DRAFT:             ["CONFIGURING"],
  CONFIGURING:       ["TESTING", "DRAFT"],
  TESTING:           ["READY_FOR_GO_LIVE", "CONFIGURING"],
  READY_FOR_GO_LIVE: ["LIVE", "TESTING"],
  LIVE:              ["PAUSED"],
  PAUSED:            ["LIVE", "CONFIGURING"],
  BLOCKED:           ["CONFIGURING"],
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? "bg-gray-100 text-gray-600";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${cls}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function CheckIcon({ status }: { status: ReadinessCheck["status"] }) {
  if (status === "pass") return <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />;
  if (status === "fail") return <XCircle className="w-4 h-4 text-red-500 shrink-0" />;
  if (status === "warn") return <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0" />;
  return <div className="w-4 h-4 rounded-full bg-gray-200 shrink-0" />;
}

function ScoreRing({ score }: { score: number }) {
  const color =
    score >= 80 ? "text-green-600" : score >= 50 ? "text-yellow-600" : "text-red-600";
  const bg =
    score >= 80 ? "bg-green-50 border-green-300" : score >= 50 ? "bg-yellow-50 border-yellow-300" : "bg-red-50 border-red-300";
  return (
    <div className={`w-16 h-16 rounded-full border-4 flex items-center justify-center ${bg}`}>
      <span className={`text-lg font-black ${color}`}>{score}</span>
    </div>
  );
}

// ── Location list ─────────────────────────────────────────────────────────────

function LocationCard({
  loc,
  selected,
  onClick,
}: {
  loc: LocationSummary;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 rounded-xl border-2 transition-all ${
        selected
          ? "border-indigo-500 bg-indigo-50"
          : "border-gray-200 hover:border-gray-300 bg-white"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 truncate">{loc.locationName}</p>
          <p className="text-xs text-gray-500 truncate">{loc.brandName}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <StatusBadge status={loc.goLiveStatus} />
          {loc.score !== null && (
            <span className="text-xs text-gray-400">Score: {loc.score}</span>
          )}
        </div>
      </div>
      {!loc.isActive && (
        <p className="text-xs text-red-500 mt-1">Location inactive</p>
      )}
    </button>
  );
}

// ── Readiness panel ───────────────────────────────────────────────────────────

function CheckRow({ check }: { check: ReadinessCheck }) {
  return (
    <div className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0">
      <CheckIcon status={check.status} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-800">{check.label}</p>
        {check.detail && (
          <p className="text-xs text-gray-500 mt-0.5">{check.detail}</p>
        )}
      </div>
      <div className="flex gap-1 shrink-0">
        {check.critical && (
          <span className="text-xs bg-red-50 text-red-600 border border-red-200 px-1.5 py-0.5 rounded">
            critical
          </span>
        )}
        {!check.adminOverridable && (
          <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">
            non-overridable
          </span>
        )}
      </div>
    </div>
  );
}

function ProviderCard({ p }: { p: ProviderReadiness }) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-gray-100 bg-gray-50">
      <Plug className={`w-5 h-5 ${p.connected ? "text-green-500" : "text-gray-300"}`} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800">{p.platform.replace(/_/g, " ")}</p>
        <p className="text-xs text-gray-500">
          {p.integrationStatus} · {p.credentialsEncrypted ? "encrypted" : "plaintext credentials"}
        </p>
      </div>
      {p.connected ? (
        <CheckCircle className="w-4 h-4 text-green-500" />
      ) : (
        <XCircle className="w-4 h-4 text-red-400" />
      )}
    </div>
  );
}

function PrinterCard({ p }: { p: PrinterReadiness }) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-gray-100 bg-gray-50">
      <Printer className={`w-5 h-5 ${p.isOnline ? "text-green-500" : "text-gray-300"}`} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800">{p.printerName}</p>
        <p className="text-xs text-gray-500">
          {p.connectionType} · {p.failedJobsLast24h} failed jobs today
        </p>
      </div>
      {p.isOnline ? (
        <Wifi className="w-4 h-4 text-green-500" />
      ) : (
        <WifiOff className="w-4 h-4 text-red-400" />
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function GoLiveWizardPage() {
  const qc = useQueryClient();
  const [selectedLocation, setSelectedLocation] = useState<LocationSummary | null>(null);
  const [tenantFilter, setTenantFilter] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // List of all locations
  const { data: locations, isLoading: loadingList, refetch: refetchList } = useQuery<LocationSummary[]>({
    queryKey: ["go-live-locations", tenantFilter],
    queryFn: () =>
      apiFetch(
        `/api/v1/onboarding/locations${tenantFilter ? `?tenantId=${encodeURIComponent(tenantFilter)}` : ""}`,
      ),
    retry: 1,
  });

  // Full readiness for the selected location
  const {
    data: readiness,
    isLoading: loadingReadiness,
    refetch: refetchReadiness,
  } = useQuery<LocationReadiness>({
    queryKey: ["go-live-readiness", selectedLocation?.locationId],
    queryFn: () =>
      apiFetch(
        `/api/v1/onboarding/locations/${selectedLocation!.locationId}/readiness?tenantId=${encodeURIComponent(selectedLocation!.tenantId)}`,
      ),
    enabled: !!selectedLocation,
    retry: 1,
  });

  // Transition mutation
  const transitionMutation = useMutation({
    mutationFn: ({
      locationId,
      tenantId,
      targetStatus,
      reason,
    }: {
      locationId: string;
      tenantId: string;
      targetStatus: string;
      reason?: string;
    }) =>
      apiFetch(`/api/v1/onboarding/locations/${locationId}/transition?tenantId=${encodeURIComponent(tenantId)}`, {
        method: "POST",
        body: JSON.stringify({ targetStatus, reason }),
      }),
    onSuccess: (data: any) => {
      setActionError(null);
      setActionSuccess(`Status updated to ${data.status}`);
      qc.invalidateQueries({ queryKey: ["go-live-locations"] });
      qc.invalidateQueries({ queryKey: ["go-live-readiness"] });
    },
    onError: (err: Error) => {
      setActionError(err.message);
      setActionSuccess(null);
    },
  });

  // Admin override mutation
  const overrideMutation = useMutation({
    mutationFn: ({
      locationId,
      tenantId,
      targetStatus,
      reason,
    }: {
      locationId: string;
      tenantId: string;
      targetStatus: string;
      reason: string;
    }) =>
      apiFetch(
        `/api/v1/onboarding/locations/${locationId}/admin-override?tenantId=${encodeURIComponent(tenantId)}`,
        {
          method: "POST",
          body: JSON.stringify({ targetStatus, reason }),
        },
      ),
    onSuccess: (data: any) => {
      setActionError(null);
      setActionSuccess(`Admin override applied — status: ${data.status}`);
      setOverrideReason("");
      qc.invalidateQueries({ queryKey: ["go-live-locations"] });
      qc.invalidateQueries({ queryKey: ["go-live-readiness"] });
    },
    onError: (err: Error) => {
      setActionError(err.message);
      setActionSuccess(null);
    },
  });

  const currentStatus = readiness?.goLiveStatus ?? selectedLocation?.goLiveStatus ?? "";
  const nextSteps = NEXT_TRANSITIONS[currentStatus] ?? [];
  const canGoLive = currentStatus === "READY_FOR_GO_LIVE" && (readiness?.blockers.length ?? 1) === 0;

  function handleTransition(targetStatus: string) {
    if (!selectedLocation) return;
    setActionError(null);
    setActionSuccess(null);
    transitionMutation.mutate({
      locationId: selectedLocation.locationId,
      tenantId: selectedLocation.tenantId,
      targetStatus,
    });
  }

  function handleAdminOverride(targetStatus: string) {
    if (!selectedLocation || !overrideReason.trim()) {
      setActionError("Override reason is required");
      return;
    }
    setActionError(null);
    setActionSuccess(null);
    overrideMutation.mutate({
      locationId: selectedLocation.locationId,
      tenantId: selectedLocation.tenantId,
      targetStatus,
      reason: overrideReason,
    });
  }

  const isBusy = transitionMutation.isPending || overrideMutation.isPending;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <Rocket className="w-6 h-6 text-indigo-600" />
            <h1 className="text-2xl font-bold text-gray-900">Go-Live Wizard</h1>
          </div>
          <p className="text-gray-500 text-sm">
            Manage location onboarding lifecycle. Mark a location LIVE only when all critical checks pass.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Left: Location list */}
          <div className="lg:col-span-1 space-y-4">
            <div className="bg-white rounded-2xl border border-gray-200 p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-gray-800 flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-gray-400" />
                  Locations
                </h2>
                <button
                  onClick={() => { refetchList(); }}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
                  title="Refresh"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>

              <input
                type="text"
                placeholder="Filter by tenant ID..."
                value={tenantFilter}
                onChange={(e) => setTenantFilter(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-indigo-300"
              />

              {loadingList ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                </div>
              ) : (
                <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
                  {(locations ?? []).map((loc) => (
                    <LocationCard
                      key={loc.locationId}
                      loc={loc}
                      selected={selectedLocation?.locationId === loc.locationId}
                      onClick={() => {
                        setSelectedLocation(loc);
                        setActionError(null);
                        setActionSuccess(null);
                      }}
                    />
                  ))}
                  {(locations ?? []).length === 0 && (
                    <p className="text-center text-sm text-gray-400 py-8">No locations found</p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Right: Readiness detail */}
          <div className="lg:col-span-2 space-y-4">
            {!selectedLocation ? (
              <div className="bg-white rounded-2xl border border-gray-200 p-12 flex flex-col items-center justify-center text-center">
                <MapPin className="w-12 h-12 text-gray-200 mb-3" />
                <p className="text-gray-400 text-sm">Select a location to view its go-live readiness</p>
              </div>
            ) : loadingReadiness ? (
              <div className="bg-white rounded-2xl border border-gray-200 p-12 flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : readiness ? (
              <>
                {/* Status header */}
                <div className="bg-white rounded-2xl border border-gray-200 p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-xl font-bold text-gray-900">{readiness.locationName}</h2>
                      <p className="text-sm text-gray-500 mt-0.5">Tenant: {readiness.tenantId}</p>
                      <div className="flex items-center gap-2 mt-2">
                        <StatusBadge status={readiness.goLiveStatus} />
                        <span className="text-xs text-gray-400">
                          Updated {new Date(readiness.lastUpdated).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <ScoreRing score={readiness.score} />
                      <button
                        onClick={() => refetchReadiness()}
                        className="text-gray-400 hover:text-gray-600"
                        title="Refresh"
                      >
                        <RefreshCw className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Action feedback */}
                  {actionError && (
                    <div className="mt-3 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                      {actionError}
                    </div>
                  )}
                  {actionSuccess && (
                    <div className="mt-3 p-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-700">
                      {actionSuccess}
                    </div>
                  )}

                  {/* Transition actions */}
                  <div className="mt-4 flex flex-wrap gap-2">
                    {nextSteps.map((target) => {
                      const isGoLive = target === "LIVE";
                      const blocked = isGoLive && !canGoLive;
                      return (
                        <button
                          key={target}
                          disabled={isBusy || blocked}
                          onClick={() => handleTransition(target)}
                          title={blocked ? "Fix all critical blockers before going live" : undefined}
                          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                            isGoLive
                              ? "bg-green-600 hover:bg-green-700 text-white"
                              : target === "PAUSED"
                              ? "bg-orange-100 hover:bg-orange-200 text-orange-700"
                              : target === "BLOCKED"
                              ? "bg-red-100 hover:bg-red-200 text-red-700"
                              : "bg-indigo-100 hover:bg-indigo-200 text-indigo-700"
                          }`}
                        >
                          {isBusy && transitionMutation.isPending ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : isGoLive ? (
                            <Rocket className="w-3 h-3" />
                          ) : target === "PAUSED" ? (
                            <Pause className="w-3 h-3" />
                          ) : target === "BLOCKED" ? (
                            <Ban className="w-3 h-3" />
                          ) : (
                            <ChevronRight className="w-3 h-3" />
                          )}
                          {target.replace(/_/g, " ")}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Blockers */}
                {readiness.blockers.length > 0 && (
                  <div className="bg-red-50 rounded-2xl border border-red-200 p-4">
                    <h3 className="font-semibold text-red-700 flex items-center gap-2 mb-3">
                      <XCircle className="w-4 h-4" />
                      {readiness.blockers.length} Critical Blocker{readiness.blockers.length !== 1 ? "s" : ""}
                    </h3>
                    {readiness.blockers.map((c) => (
                      <CheckRow key={c.key} check={c} />
                    ))}
                  </div>
                )}

                {/* Warnings */}
                {readiness.warnings.length > 0 && (
                  <div className="bg-yellow-50 rounded-2xl border border-yellow-200 p-4">
                    <h3 className="font-semibold text-yellow-700 flex items-center gap-2 mb-3">
                      <AlertTriangle className="w-4 h-4" />
                      {readiness.warnings.length} Warning{readiness.warnings.length !== 1 ? "s" : ""}
                    </h3>
                    {readiness.warnings.map((c) => (
                      <CheckRow key={c.key} check={c} />
                    ))}
                  </div>
                )}

                {/* Providers */}
                {readiness.providers.length > 0 && (
                  <div className="bg-white rounded-2xl border border-gray-200 p-4">
                    <h3 className="font-semibold text-gray-800 flex items-center gap-2 mb-3">
                      <Plug className="w-4 h-4 text-gray-400" />
                      Marketplace Providers ({readiness.providers.length})
                    </h3>
                    <div className="space-y-2">
                      {readiness.providers.map((p) => (
                        <ProviderCard key={p.platform} p={p} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Printers */}
                {readiness.printers.length > 0 && (
                  <div className="bg-white rounded-2xl border border-gray-200 p-4">
                    <h3 className="font-semibold text-gray-800 flex items-center gap-2 mb-3">
                      <Printer className="w-4 h-4 text-gray-400" />
                      Printers ({readiness.printers.length})
                    </h3>
                    <div className="space-y-2">
                      {readiness.printers.map((p) => (
                        <PrinterCard key={p.printerId} p={p} />
                      ))}
                    </div>
                  </div>
                )}

                {/* All checks */}
                <div className="bg-white rounded-2xl border border-gray-200 p-4">
                  <h3 className="font-semibold text-gray-800 flex items-center gap-2 mb-3">
                    <Shield className="w-4 h-4 text-gray-400" />
                    All Readiness Checks
                  </h3>
                  {readiness.allChecks.map((c) => (
                    <CheckRow key={c.key} check={c} />
                  ))}
                </div>

                {/* Admin override */}
                <div className="bg-white rounded-2xl border border-orange-200 p-4">
                  <h3 className="font-semibold text-orange-700 flex items-center gap-2 mb-1">
                    <Shield className="w-4 h-4" />
                    Admin Override (PLATFORM_ADMIN only)
                  </h3>
                  <p className="text-xs text-gray-500 mb-3">
                    Bypass non-critical checks. Non-overridable checks (encryption key, tenant status) cannot be bypassed.
                    All overrides are permanently logged.
                  </p>
                  <textarea
                    rows={2}
                    placeholder="Override reason (required)..."
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-orange-300 resize-none"
                  />
                  <div className="flex flex-wrap gap-2">
                    {nextSteps.map((target) => (
                      <button
                        key={`override-${target}`}
                        disabled={isBusy || !overrideReason.trim()}
                        onClick={() => handleAdminOverride(target)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-orange-100 hover:bg-orange-200 text-orange-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                      >
                        {isBusy && overrideMutation.isPending ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Shield className="w-3 h-3" />
                        )}
                        Override → {target.replace(/_/g, " ")}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
