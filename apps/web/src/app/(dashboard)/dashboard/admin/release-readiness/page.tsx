"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Gauge,
  Server,
  Database,
  Printer,
  Zap,
  Plug,
  ShoppingBag,
  Wifi,
} from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

interface ReadinessResult {
  checks: Record<string, unknown>;
  warnings: string[];
  readyScore: number;
  generatedAt: string;
}

function StatusIcon({ value }: { value: unknown }) {
  if (value === "ok" || value === true) return <CheckCircle className="w-4 h-4 text-green-500" />;
  if (value === "DOWN" || value === false) return <XCircle className="w-4 h-4 text-red-500" />;
  if (value === "degraded") return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
  return null;
}

function ScoreGauge({ score }: { score: number }) {
  const color = score >= 80 ? "text-green-600" : score >= 50 ? "text-yellow-600" : "text-red-600";
  const bg = score >= 80 ? "bg-green-50 border-green-200" : score >= 50 ? "bg-yellow-50 border-yellow-200" : "bg-red-50 border-red-200";
  return (
    <div className={`rounded-2xl border-2 p-6 text-center ${bg}`}>
      <Gauge className={`w-8 h-8 mx-auto mb-2 ${color}`} />
      <p className={`text-5xl font-black ${color}`}>{score}</p>
      <p className="text-sm text-gray-500 mt-1">Release Readiness Score</p>
      <p className={`text-xs font-medium mt-2 ${color}`}>
        {score >= 80 ? "Ready to go live" : score >= 50 ? "Needs attention" : "Not ready"}
      </p>
    </div>
  );
}

function CheckRow({ label, value, icon }: { label: string; value: unknown; icon?: React.ReactNode }) {
  const displayValue = value === null || value === undefined ? "—" : String(value);
  return (
    <div className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
      {icon && <div className="text-gray-400">{icon}</div>}
      <span className="text-sm text-gray-600 flex-1">{label}</span>
      <div className="flex items-center gap-2">
        <StatusIcon value={value} />
        <span className="text-sm font-medium text-gray-800">{displayValue}</span>
      </div>
    </div>
  );
}

export default function ReleaseReadinessPage() {
  const [tenantId, setTenantId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const { data, isLoading, refetch, error } = useQuery<ReadinessResult>({
    queryKey: ["release-readiness", tenantId, locationId],
    queryFn: () =>
      apiFetch(
        `/v1/health/release-readiness?tenantId=${encodeURIComponent(tenantId)}&locationId=${encodeURIComponent(locationId)}`,
      ),
    enabled: submitted && !!tenantId,
    staleTime: 30_000,
  });

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Release Readiness</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Check if a client location is ready to go live. Run this before onboarding any new restaurant.
        </p>
      </div>

      {/* Inputs */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-gray-500">Tenant ID</label>
            <input
              type="text"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="tenant UUID..."
              className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500">Location ID (optional)</label>
            <input
              type="text"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              placeholder="location UUID..."
              className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
        <button
          onClick={() => { setSubmitted(true); refetch(); }}
          disabled={!tenantId || isLoading}
          className="mt-4 px-5 py-2.5 rounded-lg bg-gray-900 hover:bg-gray-700 text-white text-sm font-semibold transition-colors flex items-center gap-2 disabled:opacity-50"
        >
          {isLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Gauge className="w-4 h-4" />}
          Run Readiness Check
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
          Check failed: {String(error)}
        </div>
      )}

      {data && (
        <>
          {/* Score */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <ScoreGauge score={data.readyScore} />

            {/* Warnings */}
            <div className="sm:col-span-2 bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-500" />
                Warnings ({data.warnings.length})
              </h3>
              {data.warnings.length === 0 ? (
                <div className="flex items-center gap-2 text-green-600 text-sm">
                  <CheckCircle className="w-4 h-4" /> All checks passed
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {data.warnings.map((w, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-red-700">
                      <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      {w}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-gray-400 mt-4">
                Generated at {new Date(data.generatedAt).toLocaleString()}
              </p>
            </div>
          </div>

          {/* Detailed checks */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Infrastructure */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <Server className="w-4 h-4" /> Infrastructure
              </h3>
              <CheckRow label="Environment" value={data.checks.environment} icon={<Zap className="w-3.5 h-3.5" />} />
              <CheckRow label="Database" value={data.checks.database} icon={<Database className="w-3.5 h-3.5" />} />
              <CheckRow label="Redis / Queue" value={data.checks.redis} icon={<Zap className="w-3.5 h-3.5" />} />
              <CheckRow label="Sandbox Enabled" value={data.checks.sandboxEnabled} icon={<AlertTriangle className="w-3.5 h-3.5" />} />
            </div>

            {/* Printers */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <Printer className="w-4 h-4" /> Printers
              </h3>
              <CheckRow label="Online" value={data.checks.printersOnline} icon={<Wifi className="w-3.5 h-3.5" />} />
              <CheckRow label="Offline" value={data.checks.printersOffline} />
              <CheckRow label="Failed jobs (24h)" value={data.checks.failedPrintJobsLast24h} />
            </div>

            {/* Queue */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <Zap className="w-4 h-4" /> Queue
              </h3>
              <CheckRow label="Waiting" value={data.checks.queueWaiting} />
              <CheckRow label="Active" value={data.checks.queueActive} />
              <CheckRow label="Failed" value={data.checks.queueFailed} />
            </div>

            {/* Integrations */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <Plug className="w-4 h-4" /> Integrations
              </h3>
              {(data.checks.activeIntegrations as string[])?.length > 0 ? (
                (data.checks.activeIntegrations as string[]).map((p) => (
                  <CheckRow key={p} label={p.replace(/_/g, " ")} value="ok" />
                ))
              ) : (
                <p className="text-sm text-gray-400">No active integrations</p>
              )}
            </div>

            {/* Last activity */}
            <div className="bg-white rounded-xl border border-gray-200 p-5 sm:col-span-2">
              <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <ShoppingBag className="w-4 h-4" /> Last Activity
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <CheckRow label="Last order" value={data.checks.lastOrderAt ?? "Never"} />
                <CheckRow label="Order platform" value={data.checks.lastOrderPlatform ?? "—"} />
                <CheckRow label="Last webhook" value={data.checks.lastWebhookAt ?? "Never"} />
                <CheckRow label="Webhook platform" value={data.checks.lastWebhookPlatform ?? "—"} />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
