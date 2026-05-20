"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  FlaskConical,
  Zap,
  RotateCcw,
  Copy,
  Wifi,
  WifiOff,
  Play,
  CheckCircle,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

interface SandboxResult {
  success: boolean;
  message: string;
  data?: unknown;
}

function ResultBadge({ result }: { result: SandboxResult | null }) {
  if (!result) return null;
  return (
    <div className={`flex items-start gap-2 mt-3 p-3 rounded-lg text-sm ${result.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
      {result.success ? <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
      <div>
        <p className="font-medium">{result.message}</p>
        {result.data != null && (
          <pre className="mt-1 text-xs opacity-80 overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(result.data, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function SandboxCard({ title, description, icon, children }: {
  title: string;
  description: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center text-gray-600">
          {icon}
        </div>
        <div>
          <h3 className="font-semibold text-gray-900">{title}</h3>
          <p className="text-xs text-gray-400 mt-0.5">{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

export default function SandboxPage() {
  // Order generator
  const [genCount, setGenCount] = useState(5);
  const [genPlatform, setGenPlatform] = useState("UBER_EATS");
  const [genResult, setGenResult] = useState<SandboxResult | null>(null);

  // Rush-hour simulation
  const [rushCount, setRushCount] = useState(15);
  const [rushDuration, setRushDuration] = useState(5);
  const [rushResult, setRushResult] = useState<SandboxResult | null>(null);

  // Webhook replay
  const [replayEventId, setReplayEventId] = useState("");
  const [replayResult, setReplayResult] = useState<SandboxResult | null>(null);

  // Integration outage
  const [outagePlatform, setOutagePlatform] = useState("UBER_EATS");
  const [outageDuration, setOutageDuration] = useState(60);
  const [outageResult, setOutageResult] = useState<SandboxResult | null>(null);

  const generateOrders = useMutation({
    mutationFn: () =>
      apiFetch<SandboxResult>("/v1/sandbox/generate-orders", {
        method: "POST",
        body: JSON.stringify({ count: genCount, platform: genPlatform }),
      }),
    onSuccess: (data) => setGenResult(data),
    onError: (err) => setGenResult({ success: false, message: String(err) }),
  });

  const simulateRush = useMutation({
    mutationFn: () =>
      apiFetch<SandboxResult>("/v1/sandbox/rush-hour", {
        method: "POST",
        body: JSON.stringify({ orderCount: rushCount, durationMinutes: rushDuration }),
      }),
    onSuccess: (data) => setRushResult(data),
    onError: (err) => setRushResult({ success: false, message: String(err) }),
  });

  const replayWebhook = useMutation({
    mutationFn: () =>
      apiFetch<SandboxResult>("/v1/sandbox/replay-webhook", {
        method: "POST",
        body: JSON.stringify({ eventId: replayEventId }),
      }),
    onSuccess: (data) => setReplayResult(data),
    onError: (err) => setReplayResult({ success: false, message: String(err) }),
  });

  const simulateOutage = useMutation({
    mutationFn: () =>
      apiFetch<SandboxResult>("/v1/sandbox/simulate-outage", {
        method: "POST",
        body: JSON.stringify({ platform: outagePlatform, durationSeconds: outageDuration }),
      }),
    onSuccess: (data) => setOutageResult(data),
    onError: (err) => setOutageResult({ success: false, message: String(err) }),
  });

  const clearOrders = useMutation({
    mutationFn: () =>
      apiFetch<SandboxResult>("/v1/sandbox/clear-orders", { method: "DELETE" }),
    onError: (err) => setGenResult({ success: false, message: String(err) }),
  });

  const PLATFORMS = ["UBER_EATS", "DELIVEROO", "JUST_EAT", "HUBRISE", "DIRECT", "POS"];

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-xl bg-yellow-50 flex items-center justify-center">
          <FlaskConical className="w-6 h-6 text-yellow-600" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Sandbox & Testing</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Simulate real restaurant scenarios without touching live platforms.
            Only available in non-production environments.
          </p>
        </div>
      </div>

      {/* Warning */}
      <div className="flex items-start gap-3 bg-yellow-50 border border-yellow-200 rounded-xl p-4">
        <AlertTriangle className="w-4 h-4 text-yellow-600 shrink-0 mt-0.5" />
        <p className="text-sm text-yellow-700">
          Sandbox tools generate real database records. Use the "Clear test orders" button to clean up after testing.
          <strong className="ml-1">Never run in production.</strong>
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Order generator */}
        <SandboxCard
          title="Order Generator"
          description="Create simulated orders as if they arrived from a platform webhook."
          icon={<Play className="w-4 h-4" />}
        >
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-gray-500">Platform</label>
              <select
                value={genPlatform}
                onChange={(e) => setGenPlatform(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>{p.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500">Number of orders</label>
              <input
                type="number"
                min={1}
                max={100}
                value={genCount}
                onChange={(e) => setGenCount(Number(e.target.value))}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              onClick={() => generateOrders.mutate()}
              disabled={generateOrders.isPending}
              className="w-full py-2.5 rounded-lg bg-gray-900 hover:bg-gray-700 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {generateOrders.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Generate Orders
            </button>
          </div>
          <ResultBadge result={genResult} />
        </SandboxCard>

        {/* Rush-hour simulation */}
        <SandboxCard
          title="Rush Hour Simulation"
          description="Flood the system with orders over a short period to stress-test throughput."
          icon={<Zap className="w-4 h-4" />}
        >
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-gray-500">Orders to generate</label>
              <input
                type="number"
                min={5}
                max={200}
                value={rushCount}
                onChange={(e) => setRushCount(Number(e.target.value))}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500">Spread over (minutes)</label>
              <input
                type="number"
                min={1}
                max={30}
                value={rushDuration}
                onChange={(e) => setRushDuration(Number(e.target.value))}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              onClick={() => simulateRush.mutate()}
              disabled={simulateRush.isPending}
              className="w-full py-2.5 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {simulateRush.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              Start Rush Hour
            </button>
          </div>
          <ResultBadge result={rushResult} />
        </SandboxCard>

        {/* Webhook replay */}
        <SandboxCard
          title="Webhook Replay"
          description="Re-process a stored webhook event by ID. Tests idempotency and adapter logic."
          icon={<RotateCcw className="w-4 h-4" />}
        >
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-gray-500">Webhook Event ID</label>
              <input
                type="text"
                value={replayEventId}
                onChange={(e) => setReplayEventId(e.target.value)}
                placeholder="e.g. clx1abc23def..."
                className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>
            <button
              onClick={() => replayWebhook.mutate()}
              disabled={replayWebhook.isPending || !replayEventId.trim()}
              className="w-full py-2.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {replayWebhook.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
              Replay Webhook
            </button>
          </div>
          <ResultBadge result={replayResult} />
        </SandboxCard>

        {/* Integration outage simulation */}
        <SandboxCard
          title="Outage Simulation"
          description="Block sync calls to a platform to test retry/backoff behavior under outage."
          icon={<WifiOff className="w-4 h-4" />}
        >
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-gray-500">Platform</label>
              <select
                value={outagePlatform}
                onChange={(e) => setOutagePlatform(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {["UBER_EATS", "DELIVEROO", "JUST_EAT", "HUBRISE"].map((p) => (
                  <option key={p} value={p}>{p.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500">Duration (seconds)</label>
              <input
                type="number"
                min={10}
                max={600}
                value={outageDuration}
                onChange={(e) => setOutageDuration(Number(e.target.value))}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              onClick={() => simulateOutage.mutate()}
              disabled={simulateOutage.isPending}
              className="w-full py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {simulateOutage.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <WifiOff className="w-4 h-4" />}
              Simulate Outage
            </button>
          </div>
          <ResultBadge result={outageResult} />
        </SandboxCard>
      </div>

      {/* Cleanup */}
      <div className="bg-red-50 border border-red-200 rounded-xl p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-red-800">Clear Test Data</h3>
            <p className="text-xs text-red-600 mt-0.5">
              Deletes all orders created by sandbox tools in this session.
            </p>
          </div>
          <button
            onClick={() => clearOrders.mutate()}
            disabled={clearOrders.isPending}
            className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-semibold transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            {clearOrders.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            Clear Orders
          </button>
        </div>
      </div>
    </div>
  );
}
