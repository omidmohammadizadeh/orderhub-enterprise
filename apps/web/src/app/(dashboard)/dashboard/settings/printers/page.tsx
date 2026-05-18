"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Printer,
  Wifi,
  WifiOff,
  RefreshCw,
  RotateCcw,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface PrinterRecord {
  id: string;
  name: string;
  connectionType: string;
  ipAddress: string | null;
  port: number | null;
  isOnline: boolean;
  isActive: boolean;
  locationId: string;
}

interface PrintJob {
  id: string;
  type: string;
  status: string;
  error: string | null;
  createdAt: string;
  printedAt: string | null;
  attempts: number;
}

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

const STATUS_COLOR: Record<string, string> = {
  PRINTED: "bg-green-100 text-green-700",
  FAILED: "bg-red-100 text-red-700",
  PRINTING: "bg-blue-100 text-blue-700",
  PENDING: "bg-yellow-100 text-yellow-700",
  RETRYING: "bg-orange-100 text-orange-700",
};

function JobRow({ job, printerId, onRetry }: { job: PrintJob; printerId: string; onRetry: (jobId: string) => void }) {
  return (
    <tr className="border-t border-gray-100 hover:bg-gray-50">
      <td className="py-2 px-3 text-xs text-gray-500 font-mono">{job.id.slice(-8)}</td>
      <td className="py-2 px-3 text-xs">{job.type.replace(/_/g, " ")}</td>
      <td className="py-2 px-3">
        <span className={`inline-block text-xs px-2 py-0.5 rounded-full ${STATUS_COLOR[job.status] ?? "bg-gray-100 text-gray-600"}`}>
          {job.status}
        </span>
      </td>
      <td className="py-2 px-3 text-xs text-gray-500">{job.attempts}</td>
      <td className="py-2 px-3 text-xs text-gray-400">{new Date(job.createdAt).toLocaleTimeString()}</td>
      <td className="py-2 px-3">
        {job.status === "FAILED" && (
          <button
            onClick={() => onRetry(job.id)}
            className="text-xs text-blue-600 hover:underline flex items-center gap-1"
          >
            <RotateCcw className="w-3 h-3" /> Retry
          </button>
        )}
      </td>
    </tr>
  );
}

function PrinterCard({ printer, locationId }: { printer: PrinterRecord; locationId: string }) {
  const [expanded, setExpanded] = useState(false);
  const qc = useQueryClient();

  const { data: jobs } = useQuery({
    queryKey: ["printer-jobs", printer.id],
    queryFn: () => apiFetch<PrintJob[]>(`/v1/printers/${printer.id}/jobs?limit=30`),
    enabled: expanded,
    refetchInterval: expanded ? 10_000 : false,
  });

  const testPrint = useMutation({
    mutationFn: () =>
      apiFetch(`/v1/printers/${printer.id}/test`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["printer-jobs", printer.id] }),
  });

  const retryJob = useMutation({
    mutationFn: (jobId: string) =>
      apiFetch(`/v1/printers/${printer.id}/jobs/${jobId}/retry`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["printer-jobs", printer.id] }),
  });

  const failed = jobs?.filter((j) => j.status === "FAILED") ?? [];

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center gap-3 p-4">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${printer.isOnline ? "bg-green-50" : "bg-gray-100"}`}>
          <Printer className={`w-5 h-5 ${printer.isOnline ? "text-green-600" : "text-gray-400"}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-900 truncate">{printer.name}</span>
            {printer.isOnline ? (
              <span className="flex items-center gap-1 text-xs text-green-600">
                <Wifi className="w-3 h-3" /> Online
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-gray-400">
                <WifiOff className="w-3 h-3" /> Offline
              </span>
            )}
            {failed.length > 0 && (
              <span className="flex items-center gap-1 text-xs text-red-600 bg-red-50 px-2 py-0.5 rounded-full">
                <AlertTriangle className="w-3 h-3" /> {failed.length} failed
              </span>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            {printer.connectionType} {printer.ipAddress && `· ${printer.ipAddress}:${printer.port ?? 9100}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => testPrint.mutate()}
            disabled={testPrint.isPending || !printer.isOnline}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {testPrint.isPending ? "Printing…" : "Test Print"}
          </button>
          <button onClick={() => setExpanded((v) => !v)} className="p-1.5 text-gray-400 hover:text-gray-600">
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium text-gray-700">Recent Jobs</h4>
            {failed.length > 0 && (
              <button
                onClick={() =>
                  failed.forEach((j) => retryJob.mutate(j.id))
                }
                className="text-xs text-blue-600 hover:underline flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" /> Retry all failed
              </button>
            )}
          </div>
          {!jobs ? (
            <p className="text-xs text-gray-400">Loading…</p>
          ) : jobs.length === 0 ? (
            <p className="text-xs text-gray-400">No jobs yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-400 text-left">
                    <th className="py-1 px-3">ID</th>
                    <th className="py-1 px-3">Type</th>
                    <th className="py-1 px-3">Status</th>
                    <th className="py-1 px-3">Attempts</th>
                    <th className="py-1 px-3">Created</th>
                    <th className="py-1 px-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <JobRow key={j.id} job={j} printerId={printer.id} onRetry={(id) => retryJob.mutate(id)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function PrintersPage() {
  const [locationId] = useState<string>(""); // In real app from context/URL
  const qc = useQueryClient();

  const { data: printers, isLoading, error } = useQuery({
    queryKey: ["printers", locationId],
    queryFn: () => apiFetch<PrinterRecord[]>(`/v1/printers?locationId=${locationId}`),
    refetchInterval: 30_000,
  });

  const online = printers?.filter((p) => p.isOnline).length ?? 0;
  const total = printers?.length ?? 0;
  const anyFailed = printers?.some((p) => false); // derived from jobs — placeholder

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-5 h-5 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-red-600 text-sm">Failed to load printers: {String(error)}</div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Printers</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {online}/{total} online · Heartbeat every 30s
          </p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-900 text-white text-sm hover:bg-gray-700 transition-colors">
          <Plus className="w-4 h-4" /> Add Printer
        </button>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Online", value: online, color: "text-green-600", icon: <CheckCircle className="w-4 h-4" /> },
          { label: "Offline", value: total - online, color: "text-gray-400", icon: <XCircle className="w-4 h-4" /> },
          { label: "Total", value: total, color: "text-gray-900", icon: <Printer className="w-4 h-4" /> },
        ].map(({ label, value, color, icon }) => (
          <div key={label} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
            <div className={color}>{icon}</div>
            <div>
              <p className="text-xs text-gray-400">{label}</p>
              <p className={`text-2xl font-bold ${color}`}>{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Printer list */}
      {!printers || printers.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <Printer className="w-8 h-8 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 text-sm">No printers configured.</p>
          <p className="text-gray-400 text-xs mt-1">Add a LAN, ePOS, or Star printer to get started.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {printers.map((p) => (
            <PrinterCard key={p.id} printer={p} locationId={locationId} />
          ))}
        </div>
      )}
    </div>
  );
}
