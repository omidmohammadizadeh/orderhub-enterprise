"use client";

// Which printer THIS tablet uses — a per-device setting, not a shop one.
//
// A two-till shop has two counter printers, and until this existed every
// receipt printed on both while the cash drawer that opened was whichever
// printer happened to be listed first. Staff at till B watched till A's
// drawer pop open with a customer standing at it.
//
// Scoped to the front counter on purpose: picking this tablet's printer
// replaces the OTHER counters, and never the kitchen, bar or label printers.
// Silently stopping the kitchen copy would be a worse bug than the one this
// fixes.

import { useQuery } from "@tanstack/react-query";
import { Tablet } from "lucide-react";
import { printersClient } from "@/lib/api/printers.client";
import { useDeviceStore } from "@/stores/device.store";

export function ThisTabletCard({ locationId }: { locationId?: string }) {
  const pinned = useDeviceStore((s) =>
    locationId ? (s.printerByLocation[locationId] ?? "") : "",
  );
  const setPrinter = useDeviceStore((s) => s.setPrinter);

  const { data: printers = [] } = useQuery({
    queryKey: ["printers", "list", locationId ?? "all"],
    queryFn: () => printersClient.list(locationId),
    enabled: !!locationId,
  });

  const counters = printers.filter(
    (p: any) => p.isActive !== false && p.kind === "FRONT_COUNTER",
  );
  // Nothing to decide with one counter printer, and nothing to decide with
  // none — don't put a control on screen that can't change anything.
  if (!locationId || counters.length < 2) return null;

  return (
    <section className="mb-4 rounded-xl border border-zinc-200 bg-white p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
        <Tablet className="h-4 w-4 text-zinc-500" aria-hidden /> This tablet
      </h2>
      <p className="mt-1 text-sm text-zinc-500">
        There&rsquo;s more than one counter printer here. Choose the one standing
        at this till — receipts and the cash drawer use it, and every other
        tablet keeps its own choice. Kitchen and bar printers are unaffected.
      </p>
      <label className="sr-only" htmlFor="this-tablet-printer">
        Receipt printer for this tablet
      </label>
      <select
        id="this-tablet-printer"
        value={pinned}
        onChange={(e) => setPrinter(locationId, e.target.value || null)}
        className="mt-3 w-full max-w-sm rounded-md border border-zinc-300 bg-white text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 px-3 py-2 text-sm"
      >
        <option value="">Any counter printer (not set)</option>
        {counters.map((p: any) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {!pinned && (
        <p className="mt-2 text-xs text-amber-700">
          Not set — this tablet prints to every counter printer and may open the
          wrong cash drawer.
        </p>
      )}
    </section>
  );
}
