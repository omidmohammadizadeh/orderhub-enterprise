"use client";

// Table Tabs (dine-in) — the floor view. Staff see every table (free/occupied),
// tap a free table to seat it and take its order in the POS, and free a table
// once its tab is settled. Managers define the tables and toggle the feature on
// for this location. Prices/payment reuse the normal POS + settle flow.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Utensils, Plus, Trash2, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { locationsClient } from "@/lib/api/locations.client";
import {
  tablesClient,
  type RestaurantTable,
  type UpsertTableInput,
} from "@/lib/api/tables.client";

export default function TablesPage() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const router = useRouter();
  const qc = useQueryClient();
  const [manage, setManage] = useState(false);

  const locationQuery = useQuery({
    queryKey: ["location", locationId],
    queryFn: () => locationsClient.get(locationId!),
    enabled: !!locationId,
  });
  const enabled =
    !!(locationQuery.data as any)?.settings?.tableService?.enabled;

  const tablesQuery = useQuery({
    queryKey: ["tables", locationId],
    queryFn: () => tablesClient.list(locationId!),
    enabled: !!locationId,
    refetchInterval: 15_000,
  });
  const tables = tablesQuery.data ?? [];

  const toggleMut = useMutation({
    mutationFn: (on: boolean) =>
      locationsClient.update(locationId!, {
        settings: { tableService: { enabled: on } },
      } as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["location", locationId] });
      toast.success("Saved");
    },
    onError: () => toast.error("Couldn't save"),
  });

  const seatMut = useMutation({
    mutationFn: (t: RestaurantTable) => tablesClient.seat(t.id),
    onSuccess: (_res, t) => {
      qc.invalidateQueries({ queryKey: ["tables", locationId] });
      // Take the order in the POS, scoped to this table (dine-in tab).
      router.push(
        `/dashboard/pos?tableId=${t.id}&tableName=${encodeURIComponent(t.name)}`,
      );
    },
    onError: () => toast.error("Couldn't open the table"),
  });

  const openTab = (t: RestaurantTable) =>
    router.push(
      `/dashboard/pos?tableId=${t.id}&tableName=${encodeURIComponent(t.name)}`,
    );

  const freeMut = useMutation({
    mutationFn: (t: RestaurantTable) => tablesClient.free(t.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tables", locationId] });
      toast.success("Table cleared");
    },
    onError: () => toast.error("Couldn't clear the table"),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => tablesClient.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tables", locationId] });
      toast.success("Table deleted");
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't delete"),
  });

  const areas = useMemo(() => {
    const map = new Map<string, RestaurantTable[]>();
    for (const t of tables) {
      const key = t.area?.trim() || "Main";
      (map.get(key) ?? map.set(key, []).get(key)!).push(t);
    }
    return [...map.entries()];
  }, [tables]);

  const [editing, setEditing] = useState<RestaurantTable | null>(null);
  const [creating, setCreating] = useState(false);

  if (!locationId) {
    return (
      <div className="p-6">
        <p className="text-sm text-zinc-500">
          Select a location to manage its tables.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-zinc-900">
            <Utensils className="h-5 w-5" /> Tables
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Dine-in service — open a tab on a table, add rounds, take payment at
            the end.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => toggleMut.mutate(e.target.checked)}
            />
            Table service on for this location
          </label>
          <Button variant="outline" onClick={() => setManage((m) => !m)}>
            {manage ? "Done" : "Manage tables"}
          </Button>
          {manage && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-1 h-4 w-4" /> Add table
            </Button>
          )}
        </div>
      </div>

      {!enabled && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Table service is off — turn it on above to use dine-in tabs at this
          location.
        </div>
      )}

      {tablesQuery.isLoading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : tables.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 p-10 text-center">
          <Utensils className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-600">
            No tables yet. Click <b>Manage tables → Add table</b> to set up your
            floor.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {areas.map(([area, list]) => (
            <div key={area}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                {area}
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
                {list.map((t) => {
                  const occupied = t.status === "OCCUPIED";
                  return (
                    <div
                      key={t.id}
                      className={`relative rounded-xl border p-4 text-center ${
                        occupied
                          ? "border-amber-300 bg-amber-50"
                          : "border-emerald-200 bg-emerald-50"
                      }`}
                    >
                      {manage && (
                        <div className="absolute right-1 top-1 flex gap-0.5">
                          <button
                            onClick={() => setEditing(t)}
                            className="rounded p-1 text-zinc-400 hover:text-zinc-700"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => {
                              if (confirm(`Delete table "${t.name}"?`))
                                removeMut.mutate(t.id);
                            }}
                            className="rounded p-1 text-zinc-400 hover:text-red-600"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                      <div className="text-lg font-bold text-zinc-900">
                        {t.name}
                      </div>
                      <div className="text-[11px] text-zinc-500">
                        {t.seats ? `${t.seats} seats · ` : ""}
                        {occupied ? "Occupied" : "Free"}
                      </div>
                      {!manage && (
                        <div className="mt-3">
                          {occupied ? (
                            <div className="flex flex-col gap-1">
                              <Button
                                size="sm"
                                onClick={() => openTab(t)}
                                className="w-full"
                              >
                                Open tab
                              </Button>
                              <button
                                onClick={() => {
                                  if (confirm(`Clear table "${t.name}"?`))
                                    freeMut.mutate(t);
                                }}
                                className="text-[11px] text-zinc-400 underline hover:text-zinc-700"
                              >
                                Clear table
                              </button>
                            </div>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => seatMut.mutate(t)}
                              disabled={!enabled}
                              className="w-full"
                            >
                              Seat
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <TableEditor
          locationId={locationId}
          table={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["tables", locationId] });
          }}
        />
      )}
    </div>
  );
}

function TableEditor({
  locationId,
  table,
  onClose,
  onSaved,
}: {
  locationId: string;
  table: RestaurantTable | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(table?.name ?? "");
  const [seats, setSeats] = useState<string>(table?.seats?.toString() ?? "");
  const [area, setArea] = useState(table?.area ?? "");

  const save = useMutation({
    mutationFn: () => {
      const input: UpsertTableInput = {
        locationId,
        name: name.trim(),
        seats: seats ? Number(seats) : null,
        area: area.trim() || null,
      };
      return table
        ? tablesClient.update(table.id, input)
        : tablesClient.create(input);
    },
    onSuccess: () => {
      toast.success(table ? "Table updated" : "Table added");
      onSaved();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't save"),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">
            {table ? "Edit table" : "Add table"}
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3 p-5">
          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700">
              Name / number
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. T5"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">
                Seats
              </label>
              <input
                type="number"
                min={1}
                value={seats}
                onChange={(e) => setSeats(e.target.value)}
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">
                Area (optional)
              </label>
              <input
                value={area}
                onChange={(e) => setArea(e.target.value)}
                placeholder="e.g. Terrace"
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
              />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !name.trim()}
          >
            {table ? "Save" : "Add"}
          </Button>
        </div>
      </div>
    </div>
  );
}
