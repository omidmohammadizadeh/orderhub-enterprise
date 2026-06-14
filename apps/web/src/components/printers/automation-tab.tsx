"use client";

// Phase AS-5 — Automation tab.
//
// Two location-level toggles that everyone keeps asking for:
//   - Auto-accept orders: every incoming order skips PENDING and goes
//     straight to ACCEPTED, which triggers the print pipeline.
//   - Pointer to auto-print rules: those still live per-printer because
//     each station can have its own trigger; this tab just tells the
//     operator where to find them so they stop hunting.
//
// State is stored on Location.settings (JSON). The shape is intentionally
// shallow so other tabs can park their own keys alongside.

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, Printer as PrinterIcon } from "lucide-react";
import { locationsClient } from "@/lib/api/locations.client";

export function AutomationTab({ locationId }: { locationId?: string }) {
  const qc = useQueryClient();
  const [pickedLocation, setPickedLocation] = useState(locationId ?? "");

  const locationsQuery = useQuery({
    queryKey: ["locations", "list"],
    queryFn: locationsClient.list,
  });
  const effectiveLoc = locationId ?? pickedLocation;

  const locationQuery = useQuery({
    queryKey: ["locations", "detail", effectiveLoc],
    queryFn: () => locationsClient.get(effectiveLoc),
    enabled: !!effectiveLoc,
  });

  // Location type in the web client doesn't surface `settings` yet —
  // it's a free-form Json blob on the API. Cast through unknown to read.
  const settings: any =
    (locationQuery.data as unknown as { settings?: Record<string, unknown> } | undefined)
      ?.settings ?? {};
  const [autoAccept, setAutoAccept] = useState<boolean>(
    !!settings.autoAcceptOrders,
  );

  // Reset the local toggle whenever a different location is loaded so we
  // don't keep showing the previous location's setting.
  useEffect(() => {
    setAutoAccept(!!settings.autoAcceptOrders);
  }, [locationQuery.data?.id, settings.autoAcceptOrders]);

  const save = useMutation({
    mutationFn: () =>
      locationsClient.update(effectiveLoc, {
        settings: { autoAcceptOrders: autoAccept },
      } as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["locations", "detail", effectiveLoc] });
    },
  });

  if (!effectiveLoc) {
    return (
      <div className="space-y-3">
        <select
          value={pickedLocation}
          onChange={(e) => setPickedLocation(e.target.value)}
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
        >
          <option value="">— pick a location —</option>
          {(locationsQuery.data ?? []).map((l: any) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <p className="text-sm text-zinc-500">
          Pick a location to configure its automation, or use the location
          switcher in the sidebar.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 max-w-2xl">
      {/* Auto-accept */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">
              Auto-accept orders
            </h3>
            <p className="text-xs text-zinc-500 mt-1">
              When on, every incoming order skips the pending tray and goes
              straight to <strong>Accepted</strong>. The kitchen ticket prints
              immediately. Scheduled orders and unpaid card orders are still
              held back until they're ready.
            </p>
          </div>
          <label className="relative inline-flex shrink-0 items-center cursor-pointer">
            <input
              type="checkbox"
              checked={autoAccept}
              onChange={(e) => setAutoAccept(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-zinc-200 peer-focus:ring-2 peer-focus:ring-violet-300 rounded-full peer peer-checked:bg-violet-600 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5" />
          </label>
        </div>
        <div className="flex justify-end">
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || autoAccept === !!settings.autoAcceptOrders}
            className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {save.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            <Save className="h-3 w-3" /> Save
          </button>
        </div>
      </div>

      {/* Auto-print pointer */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4 space-y-2">
        <div className="flex items-center gap-2">
          <PrinterIcon className="h-4 w-4 text-zinc-500" />
          <h3 className="text-sm font-semibold text-zinc-900">
            Auto-print rules
          </h3>
        </div>
        <p className="text-xs text-zinc-500">
          Each printer chooses which order statuses it prints on. Open the{" "}
          <strong>Printers</strong> tab, click the <strong>Edit</strong> icon
          on a printer, scroll to <strong>Auto-print rules</strong>, then add
          a status (e.g. <code className="bg-zinc-100 px-1 rounded">ORDER_ACCEPTED</code>)
          and the number of copies. Adding the same status twice prints two
          tickets.
        </p>
      </div>
    </div>
  );
}
