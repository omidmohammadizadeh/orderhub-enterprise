"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Cpu,
  Plus,
  RefreshCw,
  Trash2,
  Loader2,
  Copy as CopyIcon,
  Download,
  X,
} from "lucide-react";
import { printAgentsClient, type PrintAgent } from "@/lib/api/printers.client";
import { locationsClient } from "@/lib/api/locations.client";

const OFFLINE_MS = 90_000;

export function AgentsTab({ locationId }: { locationId?: string }) {
  const qc = useQueryClient();
  const [pairing, setPairing] = useState<null | {
    code: string;
    expiresAt: string;
    qr: string;
  }>(null);
  const [rotated, setRotated] = useState<string | null>(null);
  const [pickedLocation, setPickedLocation] = useState(locationId ?? "");

  const agentsQuery = useQuery({
    queryKey: ["print-agents", "list", locationId ?? "all"],
    queryFn: () => printAgentsClient.list(locationId),
    refetchInterval: 15_000,
  });
  const locationsQuery = useQuery({
    queryKey: ["locations", "list"],
    queryFn: locationsClient.list,
  });

  const createCode = useMutation({
    mutationFn: (loc: string) => printAgentsClient.createPairCode(loc),
    onSuccess: (r) => setPairing(r),
  });
  const rotate = useMutation({
    mutationFn: (id: string) => printAgentsClient.rotateToken(id),
    onSuccess: (r) => setRotated(r.apiToken),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => printAgentsClient.revoke(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["print-agents"] }),
  });

  return (
    <div className="space-y-4">
      {/* Phase AS-6 — Print Bridge download card. Sits above the existing
          pairing UI so operators see "download → install → pair" as one
          sequence. Links point at the latest GitHub Release artifacts;
          the URL pattern matches the workflow at
          .github/workflows/print-bridge-release.yml so it never goes
          stale when we cut a new bridge version. */}
      <BridgeDownloadCard />

      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">
          Devices running the Order Hub Print Bridge or Flutter app.
        </p>
        <div className="flex items-center gap-2">
          {!locationId && (
            <select
              value={pickedLocation}
              onChange={(e) => setPickedLocation(e.target.value)}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
            >
              <option value="">— location —</option>
              {(locationsQuery.data ?? []).map((l: any) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
          <button
            disabled={!pickedLocation || createCode.isPending}
            onClick={() => createCode.mutate(pickedLocation)}
            className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {createCode.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Pair new device
          </button>
        </div>
      </div>

      {agentsQuery.isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
      ) : (agentsQuery.data ?? []).length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-12 text-center text-sm text-zinc-500">
          No devices paired yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="min-w-full divide-y divide-zinc-200 text-sm">
            <thead className="bg-zinc-50 text-[11px] uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-3 py-2 text-left">Device</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">OS</th>
                <th className="px-3 py-2 text-left">Hostname</th>
                <th className="px-3 py-2 text-left">Version</th>
                <th className="px-3 py-2 text-left">Printers</th>
                <th className="px-3 py-2 text-left">Last seen</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {(agentsQuery.data ?? []).map((a) => (
                <AgentRow
                  key={a.id}
                  agent={a}
                  onRotate={() => rotate.mutate(a.id)}
                  onRevoke={() => {
                    if (confirm(`Revoke "${a.name}"?`)) revoke.mutate(a.id);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pairing && (
        <PairCodeModal
          pair={pairing}
          onClose={() => {
            setPairing(null);
            qc.invalidateQueries({ queryKey: ["print-agents"] });
          }}
        />
      )}
      {rotated && (
        <TokenModal
          token={rotated}
          title="New API token"
          onClose={() => setRotated(null)}
        />
      )}
    </div>
  );
}

function AgentRow({
  agent,
  onRotate,
  onRevoke,
}: {
  agent: PrintAgent;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const online =
    agent.lastSeenAt &&
    Date.now() - new Date(agent.lastSeenAt).getTime() < OFFLINE_MS;
  return (
    <tr>
      <td className="px-3 py-2">
        <div className="font-semibold">{agent.deviceName ?? agent.name}</div>
        <div className="text-[11px] text-zinc-500">{agent.kind}</div>
      </td>
      <td className="px-3 py-2">
        {online ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
            <Cpu className="h-3 w-3" /> Online
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600">
            Offline
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-xs">{agent.osType ?? "—"}</td>
      <td className="px-3 py-2 text-xs">{agent.hostname ?? "—"}</td>
      <td className="px-3 py-2 text-xs">{agent.versionString ?? "—"}</td>
      <td className="px-3 py-2 text-xs tabular-nums">{agent.printerCount}</td>
      <td className="px-3 py-2 text-xs text-zinc-500">
        {agent.lastSeenAt
          ? new Date(agent.lastSeenAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "Never"}
      </td>
      <td className="px-3 py-2">
        <div className="flex justify-end gap-1">
          <button
            onClick={onRotate}
            title="Rotate token"
            className="rounded p-1.5 text-zinc-500 hover:bg-zinc-100"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            onClick={onRevoke}
            title="Revoke"
            className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function PairCodeModal({
  pair,
  onClose,
}: {
  pair: { code: string; expiresAt: string; qr: string };
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">
            Pair new device
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-6 text-center">
          <p className="text-sm text-zinc-500">
            Run <code className="bg-zinc-100 px-1 rounded">orderhub-print-bridge pair</code>{" "}
            on the device, then enter this code:
          </p>
          <div className="text-5xl font-extrabold tracking-[0.4em] text-violet-700">
            {pair.code}
          </div>
          <p className="text-xs text-zinc-400">
            Expires {new Date(pair.expiresAt).toLocaleTimeString()}
          </p>
          <button
            onClick={() => navigator.clipboard.writeText(pair.code)}
            className="text-xs font-semibold text-violet-700 hover:text-violet-800"
          >
            Copy code
          </button>
        </div>
      </div>
    </div>
  );
}

function TokenModal({
  title,
  token,
  onClose,
}: {
  title: string;
  token: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-2 p-5">
          <p className="text-xs text-zinc-500">
            Copy and paste this into the bridge's config file. It will not be
            shown again.
          </p>
          <pre className="rounded bg-zinc-100 px-3 py-2 text-[11px] font-mono break-all">
            {token}
          </pre>
          <button
            onClick={() => navigator.clipboard.writeText(token)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-700 hover:text-violet-800"
          >
            <CopyIcon className="h-3 w-3" /> Copy
          </button>
        </div>
      </div>
    </div>
  );
}

// Phase AS-6 — Print Bridge download card. Links point at the latest
// GitHub Release. The bridge release workflow (.github/workflows/
// print-bridge-release.yml) attaches three artifacts to every
// `bridge-v*` tag with predictable filenames so we can hot-link them
// without an API roundtrip — if a release goes missing the operator
// gets a clean GitHub 404 they can screenshot rather than a confusing
// JSON error.
function BridgeDownloadCard() {
  const repo = "omidmohammadizadeh/orderhub-enterprise";
  const base = `https://github.com/${repo}/releases/latest/download`;

  const downloads = [
    {
      label: "macOS (Apple Silicon)",
      sub: "M1 / M2 / M3 / M4 — most modern Macs",
      href: `${base}/orderhub-print-bridge-macos-arm64.pkg`,
    },
    {
      label: "macOS (Intel)",
      sub: "Pre-2020 Macs",
      href: `${base}/orderhub-print-bridge-macos-x86_64.pkg`,
    },
    {
      label: "Windows 10 / 11",
      sub: "64-bit installer (.exe)",
      href: `${base}/orderhub-print-bridge-windows-x64.exe`,
    },
  ];

  return (
    <div className="rounded-lg border border-zinc-200 bg-gradient-to-br from-white to-violet-50/30 p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">
            Install the Print Bridge
          </h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            Download once per Mac or PC that prints. The installer
            registers a background service so the bridge runs at startup
            — no terminal, no manual restart. Then click{" "}
            <span className="font-semibold text-zinc-700">
              Pair new device
            </span>{" "}
            below to link it to a location.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {downloads.map((d) => (
          <a
            key={d.href}
            href={d.href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex flex-col rounded-md border border-zinc-200 bg-white px-3 py-2.5 text-xs hover:border-violet-300 hover:bg-violet-50/30"
          >
            <span className="flex items-center gap-1.5 font-semibold text-zinc-900">
              <Download className="h-3.5 w-3.5 text-violet-600" />
              {d.label}
            </span>
            <span className="mt-0.5 text-[11px] text-zinc-500">{d.sub}</span>
          </a>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-zinc-400">
        Tablets (Android / iPad) use the OrderHub mobile app instead —
        coming soon.
      </p>
    </div>
  );
}
