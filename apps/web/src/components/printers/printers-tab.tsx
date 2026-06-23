"use client";

// Printers tab — list + add wizard + per-row settings drawer.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  hasNativeBridge,
  bridgePrint,
  buildTestReceipt,
} from "@/lib/printing/bridge";
import {
  Plus,
  Wifi,
  WifiOff,
  Send,
  Pencil,
  Trash2,
  Loader2,
  CheckCircle2,
  X,
} from "lucide-react";
import {
  printersClient,
  printerStationsClient,
  type Printer,
} from "@/lib/api/printers.client";
import { locationsClient } from "@/lib/api/locations.client";

export function PrintersTab({ locationId }: { locationId?: string }) {
  const qc = useQueryClient();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<Printer | null>(null);

  const printersQuery = useQuery({
    queryKey: ["printers", "list", locationId ?? "all"],
    queryFn: printersClient.list,
    refetchInterval: 10_000,
  });
  const items = printersQuery.data ?? [];
  const filtered = locationId
    ? items.filter((p) => p.locationId === locationId)
    : items;

  const testPrint = useMutation({
    mutationFn: async (printer: any) => {
      // Bluetooth printer + native bridge available → send raw bytes
      // straight to the printer via the WebView bridge. No API round
      // trip, no PrintJob queue, no agent needed. The dashboard *is*
      // the print engine in this path.
      if (printer.connectionType === "BLUETOOTH" && hasNativeBridge()) {
        const mac = printer.ipAddress; // BT MAC is stored in ipAddress
        if (!mac) throw new Error("No Bluetooth address saved for this printer");
        const bytes = buildTestReceipt(printer.paperWidth ?? 80);
        await bridgePrint(mac, bytes);
        return { ok: true } as any;
      }
      return printersClient.testPrint(printer.id);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => printersClient.remove(id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["printers", "list"] }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">
          {filtered.length} printer{filtered.length === 1 ? "" : "s"}
        </p>
        <button
          onClick={() => setWizardOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700"
        >
          <Plus className="h-4 w-4" /> Add printer
        </button>
      </div>

      {printersQuery.isLoading ? (
        <div className="flex h-32 items-center justify-center text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-12 text-center text-sm text-zinc-500">
          No printers configured yet. Click <strong>Add printer</strong> to set
          one up.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="min-w-full divide-y divide-zinc-200 text-sm">
            <thead className="bg-zinc-50 text-[11px] uppercase tracking-wider text-zinc-500">
              <tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Type</Th>
                <Th>Transport</Th>
                <Th>Model / paper</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {filtered.map((p) => (
                <tr key={p.id}>
                  <Td>
                    <div className="font-semibold text-zinc-900">{p.name}</div>
                    <div className="text-[11px] text-zinc-500">
                      {p.ipAddress
                        ? `${p.ipAddress}:${p.port ?? 9100}`
                        : p.connectionType}
                    </div>
                  </Td>
                  <Td>
                    {p.isOnline ||
                    (p.connectionType === "BLUETOOTH" &&
                      hasNativeBridge() &&
                      p.ipAddress) ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                        <Wifi className="h-3 w-3" />
                        {p.connectionType === "BLUETOOTH" && hasNativeBridge()
                          ? "Online (tablet)"
                          : "Online"}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600">
                        <WifiOff className="h-3 w-3" /> Offline
                      </span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-xs text-zinc-600">{p.kind}</span>
                  </Td>
                  <Td>
                    <span className="text-xs text-zinc-600">
                      {p.connectionType}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-xs text-zinc-600">
                      {p.model ?? "—"} · {p.paperWidth}mm
                    </span>
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => testPrint.mutate(p)}
                        disabled={testPrint.isPending}
                        title="Send test print"
                        className="rounded p-1.5 text-zinc-500 hover:bg-violet-50 hover:text-violet-700"
                      >
                        {testPrint.isPending &&
                        testPrint.variables?.id === p.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Send className="h-4 w-4" />
                        )}
                      </button>
                      <button
                        onClick={() => setEditing(p)}
                        title="Settings"
                        className="rounded p-1.5 text-zinc-500 hover:bg-zinc-100"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`Remove printer "${p.name}"?`))
                            remove.mutate(p.id);
                        }}
                        title="Remove"
                        className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {wizardOpen && (
        <PrinterWizard
          locationId={locationId}
          onClose={() => setWizardOpen(false)}
          onSaved={() => {
            setWizardOpen(false);
            qc.invalidateQueries({ queryKey: ["printers", "list"] });
          }}
        />
      )}
      {editing && (
        <PrinterSettingsDrawer
          printer={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["printers", "list"] });
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Wizard
// ────────────────────────────────────────────────────────────────────

function PrinterWizard({
  locationId: initialLocationId,
  onClose,
  onSaved,
}: {
  locationId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [step, setStep] = useState(1);
  const [locationId, setLocationId] = useState(initialLocationId ?? "");
  const [name, setName] = useState("");
  const [type, setType] = useState<"RECEIPT" | "KITCHEN" | "LABEL" | "MULTI">(
    "KITCHEN",
  );
  const [connectionType, setConnectionType] = useState<
    "LAN" | "BLUETOOTH" | "USB"
  >("LAN");
  const [ipAddress, setIp] = useState("");
  const [port, setPort] = useState("9100");
  const [btMac, setBtMac] = useState("");
  const [paperWidth, setPaperWidth] = useState<58 | 80>(80);
  const [model, setModel] = useState("");

  // Native bridge — exposed by the OrderHub Solutions Android app via
  // window.OrderHubBT. When present we can list the tablet's paired
  // Bluetooth devices directly, so the operator doesn't have to copy
  // a MAC address by hand. When absent (desktop browser), users can
  // still type the MAC themselves.
  const [btDevices, setBtDevices] = useState<
    Array<{ name: string; address: string }>
  >([]);
  const [btScanning, setBtScanning] = useState(false);
  const [btError, setBtError] = useState<string | null>(null);
  const hasNativeBt = hasNativeBridge();

  const scanBtDevices = async () => {
    if (!hasNativeBt) return;
    setBtScanning(true);
    setBtError(null);
    try {
      const list = await (window as any).OrderHubBT.listDevices();
      setBtDevices(list);
      if (list.length === 0) {
        setBtError(
          "No paired Bluetooth devices found. Pair the printer in Android Settings → Connected devices → Pair new device, then tap Scan.",
        );
      }
    } catch (e: any) {
      setBtError(e?.message ?? "Bluetooth scan failed");
    } finally {
      setBtScanning(false);
    }
  };
  const [stationId, setStationId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const locationsQuery = useQuery({
    queryKey: ["locations", "list"],
    queryFn: locationsClient.list,
  });
  const stationsQuery = useQuery({
    queryKey: ["printer-stations", "list", locationId],
    queryFn: () => printerStationsClient.list(locationId),
    enabled: !!locationId,
  });

  const save = useMutation({
    mutationFn: () =>
      printersClient.create({
        locationId,
        name,
        type,
        connectionType,
        ...(connectionType === "LAN" && {
          ipAddress,
          port: parseInt(port, 10) || 9100,
        }),
        // No btMac column on the Printer table yet — store the MAC in
        // the existing ipAddress field. The mobile bridge reads
        // `printer.ipAddress` as the BT address when connectionType is
        // BLUETOOTH. We'll promote to a dedicated column once we add
        // BT-specific stats (signal strength, last-seen).
        ...(connectionType === "BLUETOOTH" && btMac && { ipAddress: btMac }),
        paperWidth,
        model: model || null,
        kind:
          type === "RECEIPT"
            ? "FRONT_COUNTER"
            : type === "KITCHEN"
              ? "KITCHEN"
              : type === "LABEL"
                ? "LABELS"
                : "KITCHEN",
      } as any),
    onSuccess: async (created: any) => {
      // Optionally bind to station as its default.
      if (stationId) {
        await printerStationsClient.update(stationId, {
          defaultPrinterId: created.id,
        });
      }
      onSaved();
    },
    onError: (e: any) =>
      setError(e?.response?.data?.message ?? e?.message ?? "Failed to save"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">
            Add printer ({step} of 3)
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3 p-5 max-h-[70vh] overflow-y-auto">
          {step === 1 && (
            <>
              <Field label="Location *">
                <select
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
                >
                  <option value="">— pick a location —</option>
                  {(locationsQuery.data ?? []).map((l: any) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Printer name *">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Kitchen 1"
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
                />
              </Field>
              <Field label="Type">
                <div className="grid grid-cols-4 gap-1.5">
                  {(["RECEIPT", "KITCHEN", "LABEL", "MULTI"] as const).map(
                    (t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setType(t)}
                        className={`rounded-md border px-2 py-1.5 text-xs font-semibold ${
                          type === t
                            ? "border-violet-600 bg-violet-50 text-violet-700"
                            : "border-zinc-300 text-zinc-600 hover:border-zinc-400"
                        }`}
                      >
                        {t}
                      </button>
                    ),
                  )}
                </div>
              </Field>
              {stationsQuery.data && stationsQuery.data.length > 0 && (
                <Field label="Bind as station default (optional)">
                  <select
                    value={stationId}
                    onChange={(e) => setStationId(e.target.value)}
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
                  >
                    <option value="">— none —</option>
                    {stationsQuery.data.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </>
          )}
          {step === 2 && (
            <>
              <Field label="Transport">
                <div className="grid grid-cols-3 gap-1.5">
                  {(["LAN", "BLUETOOTH", "USB"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setConnectionType(t)}
                      className={`rounded-md border px-2 py-2 text-xs font-semibold ${
                        connectionType === t
                          ? "border-violet-600 bg-violet-50 text-violet-700"
                          : "border-zinc-300 text-zinc-600 hover:border-zinc-400"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </Field>
              {connectionType === "LAN" && (
                <>
                  <Field label="IP address *">
                    <input
                      value={ipAddress}
                      onChange={(e) => setIp(e.target.value)}
                      placeholder="192.168.1.50"
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
                    />
                  </Field>
                  <Field label="Port">
                    <input
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      placeholder="9100"
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
                    />
                  </Field>
                </>
              )}
              {connectionType === "BLUETOOTH" && (
                <div className="space-y-2">
                  {hasNativeBt ? (
                    <>
                      <Field label="Paired Bluetooth devices">
                        {btDevices.length === 0 ? (
                          <button
                            type="button"
                            onClick={scanBtDevices}
                            disabled={btScanning}
                            className="w-full rounded-md border border-violet-300 bg-violet-50 px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50"
                          >
                            {btScanning
                              ? "Scanning…"
                              : "Scan paired Bluetooth devices"}
                          </button>
                        ) : (
                          <div className="space-y-1">
                            {btDevices.map((d) => (
                              <button
                                key={d.address}
                                type="button"
                                onClick={() => {
                                  setBtMac(d.address);
                                  if (!name) setName(d.name);
                                }}
                                className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm ${
                                  btMac === d.address
                                    ? "border-violet-600 bg-violet-50"
                                    : "border-zinc-300 hover:bg-zinc-50"
                                }`}
                              >
                                <span>
                                  <span className="font-medium text-zinc-900">
                                    {d.name}
                                  </span>
                                  <span className="ml-2 text-xs text-zinc-500">
                                    {d.address}
                                  </span>
                                </span>
                                {btMac === d.address && (
                                  <span className="text-xs font-semibold text-violet-700">
                                    Selected
                                  </span>
                                )}
                              </button>
                            ))}
                            <button
                              type="button"
                              onClick={scanBtDevices}
                              disabled={btScanning}
                              className="mt-1 text-xs text-violet-600 underline disabled:opacity-50"
                            >
                              {btScanning ? "Scanning…" : "Refresh list"}
                            </button>
                          </div>
                        )}
                      </Field>
                      {btError && (
                        <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-700">
                          {btError}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <Field label="Bluetooth MAC address">
                        <input
                          value={btMac}
                          onChange={(e) =>
                            setBtMac(e.target.value.toUpperCase())
                          }
                          placeholder="00:01:90:42:EE:C9"
                          className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm font-mono"
                        />
                      </Field>
                      <p className="rounded bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                        Open this page from the Order Hub Solutions tablet app
                        to see paired devices automatically.
                      </p>
                    </>
                  )}
                </div>
              )}
              {connectionType === "USB" && (
                <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  USB requires the desktop Print Bridge. Pair the bridge under
                  <strong> Agents</strong> first.
                </p>
              )}
            </>
          )}
          {step === 3 && (
            <>
              <Field label="Paper width">
                <div className="grid grid-cols-2 gap-1.5">
                  {[58, 80].map((w) => (
                    <button
                      key={w}
                      type="button"
                      onClick={() => setPaperWidth(w as 58 | 80)}
                      className={`rounded-md border px-2 py-2 text-xs font-semibold ${
                        paperWidth === w
                          ? "border-violet-600 bg-violet-50 text-violet-700"
                          : "border-zinc-300 text-zinc-600"
                      }`}
                    >
                      {w} mm
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Model (optional)">
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="Epson TM-m30"
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
                />
              </Field>
            </>
          )}
          {error && (
            <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-zinc-200 px-5 py-3">
          <button
            onClick={() => (step === 1 ? onClose() : setStep((s) => s - 1))}
            className="text-sm font-semibold text-zinc-600 hover:text-zinc-900"
          >
            {step === 1 ? "Cancel" : "Back"}
          </button>
          {step < 3 ? (
            <button
              disabled={step === 1 ? !locationId || !name : false}
              onClick={() => setStep((s) => s + 1)}
              className="rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
            >
              Next
            </button>
          ) : (
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save printer
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Settings drawer
// ────────────────────────────────────────────────────────────────────

function PrinterSettingsDrawer({
  printer,
  onClose,
  onSaved,
}: {
  printer: Printer;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [copies, setCopies] = useState<number>(printer.defaults?.copies ?? 1);
  const [printLogo, setPrintLogo] = useState<boolean>(
    !!printer.defaults?.printLogo,
  );
  const [printQr, setPrintQr] = useState<boolean>(!!printer.defaults?.qrCode);
  const [largeFont, setLargeFont] = useState<boolean>(
    !!printer.defaults?.largeFont,
  );
  const [openDrawer, setOpenDrawer] = useState<boolean>(
    !!printer.defaults?.openCashDrawer,
  );
  const [autoCut, setAutoCut] = useState<boolean>(printer.supportsCut);
  const [rules, setRules] = useState<
    { trigger: string; copies: number }[]
  >(Array.isArray(printer.autoPrintRules) ? printer.autoPrintRules : []);

  const save = useMutation({
    mutationFn: () =>
      printersClient.update(printer.id, {
        defaults: {
          copies,
          printLogo,
          qrCode: printQr,
          largeFont,
          openCashDrawer: openDrawer,
        },
        supportsCut: autoCut,
        autoPrintRules: rules as any,
      } as any),
    onSuccess: onSaved,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-zinc-900/40 p-4">
      <div className="w-full max-w-xl rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">
            {printer.name}
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-5 max-h-[70vh] overflow-y-auto">
          <Section title="Defaults">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Copies">
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={copies}
                  onChange={(e) => setCopies(parseInt(e.target.value, 10) || 1)}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
                />
              </Field>
              <Toggle
                label="Print logo"
                value={printLogo}
                onChange={setPrintLogo}
              />
              <Toggle
                label="Print QR code"
                value={printQr}
                onChange={setPrintQr}
              />
              <Toggle
                label="Large font"
                value={largeFont}
                onChange={setLargeFont}
              />
              <Toggle
                label="Open cash drawer"
                value={openDrawer}
                onChange={setOpenDrawer}
              />
              <Toggle label="Auto cut" value={autoCut} onChange={setAutoCut} />
            </div>
          </Section>

          <Section title="Auto-print rules">
            <p className="text-xs text-zinc-500 mb-2">
              Decide which order events trigger a print on this printer. Add
              the same trigger twice to print extra copies for that trigger.
            </p>
            <div className="space-y-1.5">
              {rules.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={r.trigger}
                    onChange={(e) => {
                      const next = [...rules];
                      next[i] = { ...next[i]!, trigger: e.target.value };
                      setRules(next);
                    }}
                    className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm"
                  >
                    {[
                      "ORDER_RECEIVED",
                      "ORDER_ACCEPTED",
                      "ORDER_PREPARING",
                      "ORDER_READY",
                      "MANUAL_ONLY",
                    ].map((t) => (
                      <option key={t} value={t}>
                        {t.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={r.copies}
                    onChange={(e) => {
                      const next = [...rules];
                      next[i] = {
                        ...next[i]!,
                        copies: parseInt(e.target.value, 10) || 1,
                      };
                      setRules(next);
                    }}
                    className="w-16 rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
                  />
                  <button
                    onClick={() => setRules(rules.filter((_, j) => j !== i))}
                    className="text-zinc-400 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <button
                onClick={() =>
                  setRules([
                    ...rules,
                    { trigger: "ORDER_ACCEPTED", copies: 1 },
                  ])
                }
                className="text-xs font-semibold text-violet-700 hover:text-violet-800"
              >
                + Add rule
              </button>
            </div>
          </Section>
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
            disabled={save.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Small primitives ──────────────────────────────────────────────────

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">
      {children}
    </th>
  );
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 align-middle">{children}</td>;
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-zinc-600 mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}
function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 text-sm">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
        {title}
      </h3>
      {children}
    </div>
  );
}
