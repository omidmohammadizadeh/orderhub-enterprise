"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { printerStationsClient, printersClient } from "@/lib/api/printers.client";
import { locationsClient } from "@/lib/api/locations.client";

const KINDS = [
  "KITCHEN",
  "FRONT_COUNTER",
  "BAR",
  "LABELS",
  "DISPATCH",
  "EXPO",
  "OTHER",
] as const;

export function StationsTab({ locationId }: { locationId?: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("KITCHEN");
  const [printerId, setPrinterId] = useState<string>("");
  const [pickedLocation, setPickedLocation] = useState(locationId ?? "");

  const stationsQuery = useQuery({
    queryKey: ["printer-stations", "list", locationId ?? "all"],
    queryFn: () => printerStationsClient.list(locationId),
  });
  const printersQuery = useQuery({
    queryKey: ["printers", "list"],
    queryFn: printersClient.list,
  });
  const locationsQuery = useQuery({
    queryKey: ["locations", "list"],
    queryFn: locationsClient.list,
  });

  const create = useMutation({
    mutationFn: () =>
      printerStationsClient.create({
        locationId: pickedLocation,
        name,
        kind,
        defaultPrinterId: printerId || undefined,
      }),
    onSuccess: () => {
      setName("");
      setPrinterId("");
      qc.invalidateQueries({ queryKey: ["printer-stations"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => printerStationsClient.remove(id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["printer-stations"] }),
  });

  const printers = printersQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-zinc-900 mb-2">
          New station
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
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
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Pizza station"
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as any)}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <select
            value={printerId}
            onChange={(e) => setPrinterId(e.target.value)}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value="">— default printer (optional) —</option>
            {printers
              .filter((p) => !pickedLocation || p.locationId === pickedLocation)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </div>
        <button
          onClick={() => create.mutate()}
          disabled={!name || !pickedLocation || create.isPending}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <Plus className="h-4 w-4" /> Add station
        </button>
      </div>

      {(stationsQuery.data ?? []).length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-12 text-center text-sm text-zinc-500">
          No stations yet. Create one above.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="min-w-full divide-y divide-zinc-200 text-sm">
            <thead className="bg-zinc-50 text-[11px] uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Kind</th>
                <th className="px-3 py-2 text-left">Default printer</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {(stationsQuery.data ?? []).map((s) => (
                <tr key={s.id}>
                  <td className="px-3 py-2 font-semibold">{s.name}</td>
                  <td className="px-3 py-2 text-xs text-zinc-600">
                    {s.kind.replace(/_/g, " ")}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-600">
                    {s.defaultPrinter?.name ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => {
                        if (confirm(`Delete station "${s.name}"?`))
                          remove.mutate(s.id);
                      }}
                      className="text-zinc-400 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
