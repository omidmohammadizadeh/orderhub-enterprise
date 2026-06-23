"use client";

// Printers — Bluetooth-first, single screen.
//
// Our setup is deliberately simple: the Order Hub Solutions Android app
// wraps this dashboard in a WebView and injects window.OrderHubBT. The
// operator pairs the receipt printer (Epson TM-m30II etc.) in Android
// Settings, opens this page, picks the paired printer, and turns on
// auto-print. From then on every accepted order prints straight to the
// printer over Bluetooth — no agents, no LAN, no print queue to babysit.
//
// What this page does, top to bottom:
//   1. Bridge status — are we inside the tablet app?
//   2. Receipt printer — connect / test / copies / auto-print toggle.
//   3. Recent prints — live view so you can see it working.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Printer as PrinterIcon,
  Bluetooth,
  Plus,
  Send,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Smartphone,
  X,
  RefreshCw,
} from "lucide-react";
import {
  printersClient,
  type Printer,
  type PrintJobRow,
} from "@/lib/api/printers.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import {
  hasNativeBridge,
  bridgePrint,
  buildTestReceipt,
} from "@/lib/printing/bridge";

export default function PrintersPage() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const qc = useQueryClient();
  const nativeBridge = hasNativeBridge();
  const [connectOpen, setConnectOpen] = useState(false);

  const printersQuery = useQuery({
    queryKey: ["printers", "list", locationId ?? "all"],
    queryFn: () => printersClient.list(locationId ?? undefined),
    refetchInterval: 15_000,
  });

  const printers = useMemo(() => {
    const all = printersQuery.data ?? [];
    const scoped = locationId
      ? all.filter((p) => p.locationId === locationId)
      : all;
    // Bluetooth printers first — that's our supported path.
    return [...scoped].sort((a, b) =>
      a.connectionType === "BLUETOOTH" ? -1 : b.connectionType === "BLUETOOTH" ? 1 : 0,
    );
  }, [printersQuery.data, locationId]);

  const refreshPrinters = () =>
    qc.invalidateQueries({ queryKey: ["printers", "list"] });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">Printers</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Connect your Bluetooth receipt printer and print every order
          automatically.
        </p>
      </div>

      <BridgeStatus native={nativeBridge} />

      {/* Receipt printer(s) */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Receipt printer
          </h2>
          <button
            onClick={() => setConnectOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700"
          >
            <Plus className="h-4 w-4" /> Connect printer
          </button>
        </div>

        {printersQuery.isLoading ? (
          <div className="flex h-28 items-center justify-center rounded-xl border border-zinc-200 bg-white text-sm text-zinc-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : printers.length === 0 ? (
          <EmptyState native={nativeBridge} onConnect={() => setConnectOpen(true)} />
        ) : (
          <div className="space-y-3">
            {printers.map((p) => (
              <PrinterCard
                key={p.id}
                printer={p}
                native={nativeBridge}
                onChanged={refreshPrinters}
              />
            ))}
          </div>
        )}
      </section>

      <RecentPrints locationId={locationId ?? undefined} />

      {connectOpen && (
        <ConnectModal
          locationId={locationId ?? undefined}
          onClose={() => setConnectOpen(false)}
          onConnected={() => {
            setConnectOpen(false);
            refreshPrinters();
          }}
        />
      )}
    </div>
  );
}

// ── Bridge status banner ──────────────────────────────────────────────

function BridgeStatus({ native }: { native: boolean }) {
  if (native) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
        <Bluetooth className="h-5 w-5 text-emerald-600" />
        <div className="text-sm">
          <p className="font-semibold text-emerald-800">
            Connected to this tablet
          </p>
          <p className="text-emerald-700">
            Bluetooth printing is available on this device.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <Smartphone className="h-5 w-5 text-amber-600" />
      <div className="text-sm">
        <p className="font-semibold text-amber-800">
          Open on the Order Hub tablet app to print
        </p>
        <p className="text-amber-700">
          Bluetooth printing runs on the tablet. You can view and change
          settings here, but connect and test prints from the app.
        </p>
      </div>
    </div>
  );
}

function EmptyState({
  native,
  onConnect,
}: {
  native: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center">
      <PrinterIcon className="mx-auto h-8 w-8 text-zinc-300" />
      <p className="mt-3 text-sm font-semibold text-zinc-700">
        No printer connected yet
      </p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500">
        Pair your printer in Android Settings → Connected devices, then
        connect it here. Orders will print automatically when you accept
        them.
      </p>
      {native && (
        <button
          onClick={onConnect}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700"
        >
          <Plus className="h-4 w-4" /> Connect printer
        </button>
      )}
    </div>
  );
}

// ── Printer card ──────────────────────────────────────────────────────

function PrinterCard({
  printer,
  native,
  onChanged,
}: {
  printer: Printer;
  native: boolean;
  onChanged: () => void;
}) {
  const isBt = printer.connectionType === "BLUETOOTH";
  const mac = printer.ipAddress;
  const [testState, setTestState] = useState<
    "idle" | "printing" | "ok" | "error"
  >("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const copies = Number(printer.defaults?.copies ?? 1) || 1;

  const setAuto = useMutation({
    mutationFn: (active: boolean) =>
      printersClient.setReceiptDefault(printer.id, active),
    onSuccess: onChanged,
  });
  const setCopies = useMutation({
    mutationFn: (n: number) =>
      printersClient.update(printer.id, {
        defaults: { ...(printer.defaults ?? {}), copies: n },
      } as any),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => printersClient.remove(printer.id),
    onSuccess: onChanged,
  });

  const runTest = async () => {
    setTestError(null);
    setTestState("printing");
    try {
      if (isBt && native) {
        if (!mac) throw new Error("No Bluetooth address saved");
        await bridgePrint(mac, buildTestReceipt(printer.paperWidth ?? 80));
      } else {
        await printersClient.testPrint(printer.id);
      }
      setTestState("ok");
      setTimeout(() => setTestState("idle"), 2500);
    } catch (e: any) {
      setTestError(e?.message ?? "Test print failed");
      setTestState("error");
      setTimeout(() => setTestState("idle"), 4000);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-violet-50 p-2 text-violet-600">
            {isBt ? (
              <Bluetooth className="h-5 w-5" />
            ) : (
              <PrinterIcon className="h-5 w-5" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-zinc-900">{printer.name}</span>
              {printer.isReceiptDefault && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                  <CheckCircle2 className="h-3 w-3" /> Auto-print
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-zinc-500">
              {isBt ? "Bluetooth" : printer.connectionType}
              {mac ? ` · ${mac}` : ""} · {printer.paperWidth ?? 80}mm
            </p>
          </div>
        </div>
        <button
          onClick={() => {
            if (confirm(`Disconnect "${printer.name}"?`)) remove.mutate();
          }}
          title="Disconnect"
          className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {/* Controls */}
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {/* Auto-print toggle */}
        <label className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2">
          <span className="text-sm text-zinc-700">Auto-print orders</span>
          <button
            role="switch"
            aria-checked={!!printer.isReceiptDefault}
            disabled={setAuto.isPending}
            onClick={() => setAuto.mutate(!printer.isReceiptDefault)}
            className={`relative h-5 w-9 rounded-full transition-colors ${
              printer.isReceiptDefault ? "bg-emerald-500" : "bg-zinc-300"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                printer.isReceiptDefault ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        </label>

        {/* Copies */}
        <label className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2">
          <span className="text-sm text-zinc-700">Copies</span>
          <select
            value={copies}
            onChange={(e) => setCopies.mutate(parseInt(e.target.value, 10) || 1)}
            disabled={setCopies.isPending}
            className="rounded-md border border-zinc-300 px-2 py-1 text-sm"
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        {/* Test print */}
        <button
          onClick={runTest}
          disabled={testState === "printing"}
          className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-semibold ${
            testState === "ok"
              ? "border-emerald-300 bg-emerald-50 text-emerald-700"
              : testState === "error"
                ? "border-red-300 bg-red-50 text-red-700"
                : "border-zinc-300 text-zinc-700 hover:bg-zinc-50"
          }`}
        >
          {testState === "printing" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : testState === "ok" ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : testState === "error" ? (
            <XCircle className="h-4 w-4" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          {testState === "ok"
            ? "Sent"
            : testState === "error"
              ? "Failed"
              : "Test print"}
        </button>
      </div>
      {testError && (
        <p className="mt-2 rounded bg-red-50 px-3 py-2 text-xs text-red-700">
          {testError}
        </p>
      )}
    </div>
  );
}

// ── Connect modal ─────────────────────────────────────────────────────

function ConnectModal({
  locationId,
  onClose,
  onConnected,
}: {
  locationId?: string;
  onClose: () => void;
  onConnected: () => void;
}) {
  const native = hasNativeBridge();
  const [devices, setDevices] = useState<
    Array<{ name: string; address: string }>
  >([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [mac, setMac] = useState("");
  const [name, setName] = useState("");
  const [paperWidth, setPaperWidth] = useState<58 | 80>(80);
  const [error, setError] = useState<string | null>(null);

  const scan = async () => {
    if (!native) return;
    setScanning(true);
    setScanError(null);
    try {
      const list = await (window as any).OrderHubBT.listDevices();
      setDevices(list ?? []);
      if (!list || list.length === 0) {
        setScanError(
          "No paired Bluetooth devices. Pair the printer in Android Settings → Connected devices → Pair new device, then tap Scan.",
        );
      }
    } catch (e: any) {
      setScanError(e?.message ?? "Bluetooth scan failed");
    } finally {
      setScanning(false);
    }
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!locationId) throw new Error("Pick a location first");
      if (!mac) throw new Error("Select a printer");
      const created = await printersClient.create({
        locationId,
        name: name || "Receipt printer",
        type: "RECEIPT",
        connectionType: "BLUETOOTH",
        ipAddress: mac, // BT MAC is stored in ipAddress
        paperWidth,
        kind: "FRONT_COUNTER",
        supportsCut: true,
      } as any);
      // Make this the auto-print receipt target (repoints even if an old
      // printer was previously bound).
      await printersClient.setReceiptDefault((created as any).id, true);
      return created;
    },
    onSuccess: onConnected,
    onError: (e: any) =>
      setError(e?.response?.data?.message ?? e?.message ?? "Failed to connect"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">
            Connect a printer
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {!native ? (
            <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Open this page on the Order Hub tablet app to scan paired
              Bluetooth printers.
            </div>
          ) : (
            <>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="text-xs font-semibold text-zinc-600">
                    Paired Bluetooth devices
                  </label>
                  <button
                    onClick={scan}
                    disabled={scanning}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-violet-700 hover:text-violet-800 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-3 w-3 ${scanning ? "animate-spin" : ""}`}
                    />
                    {scanning ? "Scanning…" : "Scan"}
                  </button>
                </div>
                {devices.length === 0 ? (
                  <button
                    onClick={scan}
                    disabled={scanning}
                    className="w-full rounded-lg border border-violet-300 bg-violet-50 px-3 py-3 text-sm font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50"
                  >
                    {scanning ? "Scanning…" : "Scan for paired printers"}
                  </button>
                ) : (
                  <div className="space-y-1.5">
                    {devices.map((d) => (
                      <button
                        key={d.address}
                        onClick={() => {
                          setMac(d.address);
                          if (!name) setName(d.name);
                        }}
                        className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm ${
                          mac === d.address
                            ? "border-violet-600 bg-violet-50"
                            : "border-zinc-300 hover:bg-zinc-50"
                        }`}
                      >
                        <span>
                          <span className="font-medium text-zinc-900">
                            {d.name || "Unnamed device"}
                          </span>
                          <span className="ml-2 font-mono text-xs text-zinc-500">
                            {d.address}
                          </span>
                        </span>
                        {mac === d.address && (
                          <CheckCircle2 className="h-4 w-4 text-violet-600" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {scanError && (
                  <p className="mt-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    {scanError}
                  </p>
                )}
              </div>

              {mac && (
                <>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-zinc-600">
                      Printer name
                    </label>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Receipt printer"
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-zinc-600">
                      Paper width
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {[80, 58].map((w) => (
                        <button
                          key={w}
                          onClick={() => setPaperWidth(w as 58 | 80)}
                          className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                            paperWidth === w
                              ? "border-violet-600 bg-violet-50 text-violet-700"
                              : "border-zinc-300 text-zinc-600"
                          }`}
                        >
                          {w} mm
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {error && (
            <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={!mac || save.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Connect &amp; enable auto-print
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Recent prints ─────────────────────────────────────────────────────

function RecentPrints({ locationId }: { locationId?: string }) {
  const jobsQuery = useQuery({
    queryKey: ["print-jobs", "recent", locationId ?? "all"],
    queryFn: () => printersClient.listJobs(locationId, 20),
    refetchInterval: 8_000,
  });
  const jobs = jobsQuery.data ?? [];

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Recent prints
      </h2>
      {jobsQuery.isLoading ? (
        <div className="flex h-20 items-center justify-center rounded-xl border border-zinc-200 bg-white text-sm text-zinc-400">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : jobs.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500">
          No prints yet. Accepted orders will appear here.
        </div>
      ) : (
        <div className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white">
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </div>
      )}
    </section>
  );
}

function JobRow({ job }: { job: PrintJobRow }) {
  const label = job.type
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
  const when = new Date(job.printedAt ?? job.createdAt);
  return (
    <div className="flex items-center justify-between px-4 py-2.5 text-sm">
      <div className="flex items-center gap-2">
        <StatusBadge status={job.status} />
        <span className="text-zinc-700">{label}</span>
        {job.copies > 1 && (
          <span className="text-xs text-zinc-400">×{job.copies}</span>
        )}
      </div>
      <span className="text-xs text-zinc-400">
        {when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<
    string,
    { cls: string; icon: any; text: string }
  > = {
    PRINTED: {
      cls: "bg-emerald-50 text-emerald-700",
      icon: CheckCircle2,
      text: "Printed",
    },
    FAILED: { cls: "bg-red-50 text-red-700", icon: XCircle, text: "Failed" },
    QUEUED: { cls: "bg-amber-50 text-amber-700", icon: Clock, text: "Queued" },
    PRINTING: {
      cls: "bg-blue-50 text-blue-700",
      icon: Loader2,
      text: "Printing",
    },
  };
  const s = map[status] ?? {
    cls: "bg-zinc-100 text-zinc-600",
    icon: Clock,
    text: status,
  };
  const Icon = s.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}
    >
      <Icon className={`h-3 w-3 ${status === "PRINTING" ? "animate-spin" : ""}`} />
      {s.text}
    </span>
  );
}
