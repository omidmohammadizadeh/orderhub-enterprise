"use client";

// Table Tabs (dine-in) — the floor view. Staff see every table (free/occupied),
// tap a free table to seat it and take its order in the POS, and free a table
// once its tab is settled. Managers define the tables and toggle the feature on
// for this location. Prices/payment reuse the normal POS + settle flow.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  Utensils,
  Plus,
  Trash2,
  Pencil,
  X,
  LayoutGrid,
  List as ListIcon,
  MoreHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth.store";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { queryKeys } from "@/lib/api/query-keys";
import { locationsClient } from "@/lib/api/locations.client";
import {
  tablesClient,
  type LayoutNode,
  type RestaurantTable,
  type SittingInput,
  type UpsertTableInput,
} from "@/lib/api/tables.client";
import { FloorPlan, elapsedLabel } from "@/components/tables/floor-plan";
import { SeatDialog } from "@/components/tables/seat-dialog";
import { TableActionsModal } from "@/components/tables/table-actions-modal";
import { TableQrModal } from "@/components/tables/table-qr-modal";

type View = "plan" | "list";
const VIEW_KEY = "oh.tables.view";

// Same list the API's @Roles(...MANAGE) uses on POST /v1/tables/layout —
// showing "Edit layout" to a cashier would only earn them a 403.
const MANAGE_ROLES = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "MANAGER",
  "DARK_KITCHEN_MANAGER",
];

export default function TablesPage() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const router = useRouter();
  const qc = useQueryClient();
  const [manage, setManage] = useState(false);
  // Service essentials — "Move / merge" picker: the tab being moved.
  const [moveFrom, setMoveFrom] = useState<RestaurantTable | null>(null);

  // Whichever view a till was left on is the one that shift wants back.
  // Read after mount so the server and first client render agree.
  const [view, setView] = useState<View>("plan");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      if (saved === "plan" || saved === "list") setView(saved);
    } catch {
      /* private mode — the default is fine */
    }
  }, []);
  const chooseView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };

  // Tile-level dialogs are keyed by id, not by a snapshot of the row, so a
  // refetch (or a mutation the dialog itself fired) is reflected live.
  const [seatId, setSeatId] = useState<string | null>(null);
  const [actionsId, setActionsId] = useState<string | null>(null);
  const [qrId, setQrId] = useState<string | null>(null);

  const role = useAuthStore((s) => s.user?.role);
  const canManage = !!role && MANAGE_ROLES.includes(role as string);

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
    // The locations PATCH shallow-merges the TOP level of settings only,
    // so sending a bare `{ tableService: { enabled } }` replaces the whole
    // tableService object and silently wipes the reservations settings
    // underneath it. Spread both levels.
    mutationFn: (on: boolean) => {
      const settings = ((locationQuery.data as any)?.settings ?? {}) as Record<
        string,
        any
      >;
      return locationsClient.update(locationId!, {
        settings: {
          ...settings,
          tableService: { ...(settings.tableService ?? {}), enabled: on },
        },
      } as any);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["location", locationId] });
      // The sidebar + reservations pages read the location under the
      // shared key, so invalidate that too or the nav lags by a minute.
      qc.invalidateQueries({ queryKey: queryKeys.locationDetail(locationId!) });
      toast.success("Saved");
    },
    onError: () => toast.error("Couldn't save"),
  });

  const seatMut = useMutation({
    mutationFn: (v: { table: RestaurantTable; input?: SittingInput }) =>
      tablesClient.seat(v.table.id, v.input),
    onSuccess: (_res, v) => {
      qc.invalidateQueries({ queryKey: ["tables", locationId] });
      setSeatId(null);
      setActionsId(null);
      // Take the order in the POS, scoped to this table (dine-in tab).
      router.push(
        `/dashboard/pos?tableId=${v.table.id}&tableName=${encodeURIComponent(v.table.name)}`,
      );
    },
    // The API refuses to seat an out-of-service table and says why.
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't open the table"),
  });

  const layoutMut = useMutation({
    mutationFn: async (v: { nodes: LayoutNode[]; unplacedIds: string[] }) => {
      // The layout endpoint always writes numbers, so "took it off the plan"
      // has to go back through the normal update with explicit nulls.
      for (const id of v.unplacedIds) {
        await tablesClient.update(id, { posX: null, posY: null });
      }
      if (v.nodes.length) await tablesClient.saveLayout(locationId!, v.nodes);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tables", locationId] });
      toast.success("Floor plan saved");
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't save the floor plan"),
  });

  const openTab = (t: RestaurantTable) =>
    router.push(
      `/dashboard/pos?tableId=${t.id}&tableName=${encodeURIComponent(t.name)}`,
    );

  const freeMut = useMutation({
    mutationFn: (t: RestaurantTable) => tablesClient.free(t.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tables", locationId] });
      setActionsId(null);
      toast.success("Table cleared");
    },
    onError: () => toast.error("Couldn't clear the table"),
  });

  const moveMut = useMutation({
    mutationFn: (v: { fromId: string; toId: string }) =>
      tablesClient.move(v.fromId, v.toId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tables", locationId] });
      setMoveFrom(null);
      toast.success("Tab moved");
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't move the tab"),
  });

  const mergeMut = useMutation({
    mutationFn: (v: { fromId: string; intoId: string }) =>
      tablesClient.merge(v.fromId, v.intoId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tables", locationId] });
      setMoveFrom(null);
      toast.success("Tabs merged");
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't merge the tabs"),
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

  // Which area the floor plan is showing. null = every area at once.
  // Areas are derived from Table.area, so a brand-new area starts empty and
  // becomes real as soon as a table is dropped onto its plan.
  const [activeArea, setActiveArea] = useState<string | null>(null);
  const areaNames = useMemo(
    () => areas.map(([name]) => name),
    [areas],
  );
  // An area the manager just invented, kept until a table lands in it.
  const [pendingArea, setPendingArea] = useState<string | null>(null);
  const areaTabs = useMemo(() => {
    const all = [...areaNames];
    if (pendingArea && !all.includes(pendingArea)) all.push(pendingArea);
    return all;
  }, [areaNames, pendingArea]);
  // An area that gained its first table is no longer "pending".
  useEffect(() => {
    if (pendingArea && areaNames.includes(pendingArea)) setPendingArea(null);
  }, [areaNames, pendingArea]);

  const planTables = useMemo(
    () =>
      activeArea
        ? tables.filter((t) => (t.area?.trim() || "Main") === activeArea)
        : tables,
    [tables, activeArea],
  );

  // The list view shows how long a table has been occupied too — the floor
  // plan already did, and staff shouldn't have to switch view to see it.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const [editing, setEditing] = useState<RestaurantTable | null>(null);
  const [creating, setCreating] = useState(false);

  const byId = (id: string | null) =>
    id ? (tables.find((t) => t.id === id) ?? null) : null;
  const seatTable = byId(seatId);
  const actionsTable = byId(actionsId);
  const qrTable = byId(qrId);

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
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-md border border-zinc-200 p-0.5">
            <button
              onClick={() => chooseView("plan")}
              className={`flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium ${
                view === "plan"
                  ? "bg-zinc-900 text-white"
                  : "text-zinc-500 hover:text-zinc-900"
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" /> Floor plan
            </button>
            <button
              onClick={() => chooseView("list")}
              className={`flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium ${
                view === "list"
                  ? "bg-zinc-900 text-white"
                  : "text-zinc-500 hover:text-zinc-900"
              }`}
            >
              <ListIcon className="h-3.5 w-3.5" /> List
            </button>
          </div>
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
      ) : tablesQuery.isError ? (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          Couldn&apos;t load the tables.{" "}
          <button
            onClick={() => tablesQuery.refetch()}
            className="underline hover:no-underline"
          >
            Try again
          </button>
        </div>
      ) : tables.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 p-10 text-center">
          <Utensils className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-600">
            No tables yet. Click <b>Manage tables → Add table</b> to set up your
            floor.
          </p>
        </div>
      ) : view === "plan" ? (
        <>
          {/* Area tabs. A big site plans floor by floor, not all at once,
              so the canvas shows one room at a time. "All areas" is still
              there for a small shop that never split its floor up. */}
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setActiveArea(null)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                activeArea === null
                  ? "bg-zinc-900 text-white"
                  : "border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              All areas
            </button>
            {areaTabs.map((name) => (
              <button
                key={name}
                onClick={() => setActiveArea(name)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                  activeArea === name
                    ? "bg-zinc-900 text-white"
                    : "border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"
                }`}
              >
                {name}
                {pendingArea === name && (
                  <span className="ml-1 text-[10px] opacity-60">(new)</span>
                )}
              </button>
            ))}
            {canManage && (
              <button
                onClick={() => {
                  const name = prompt(
                    "Name this area (e.g. Upstairs, Garden, Bar)",
                  )?.trim();
                  if (!name) return;
                  setPendingArea(name);
                  setActiveArea(name);
                }}
                className="rounded-full border border-dashed border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-500 hover:border-zinc-400 hover:text-zinc-700"
              >
                <Plus className="mr-0.5 inline h-3 w-3" /> New area
              </button>
            )}
          </div>

          {activeArea && planTables.length === 0 && (
            <p className="mb-3 rounded-md border border-dashed border-zinc-300 bg-white px-4 py-3 text-xs text-zinc-500">
              Nothing in <b>{activeArea}</b> yet. Open <b>Edit layout</b> and
              drag a table across from <b>Not on the plan</b> — dropping it
              here moves it into this area.
            </p>
          )}

          <FloorPlan
          tables={planTables}
          activeArea={activeArea}
          serviceEnabled={enabled}
          canManage={canManage}
          onOpenTable={(t) =>
            t.status === "OCCUPIED" ? openTab(t) : setSeatId(t.id)
          }
          onTableActions={(t) => setActionsId(t.id)}
          onSaveLayout={(nodes, unplacedIds) =>
            layoutMut.mutateAsync({ nodes, unplacedIds })
          }
          savingLayout={layoutMut.isPending}
          />
        </>
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
                      {/* The list has no tiles to long-press, so availability
                          / QR need their own way in. */}
                      {!manage && (
                        <button
                          onClick={() => setActionsId(t.id)}
                          aria-label={`Actions for ${t.name}`}
                          className="absolute right-1 top-1 rounded p-1 text-zinc-400 hover:text-zinc-700"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                      )}
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
                        {occupied && elapsedLabel(t.openedAt, now) && (
                          <span className="font-medium text-amber-700">
                            {" · "}
                            {elapsedLabel(t.openedAt, now)}
                          </span>
                        )}
                        {occupied && t.covers ? (
                          <span className="text-zinc-400">
                            {" · "}
                            {t.covers} guests
                          </span>
                        ) : null}
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
                              <div className="flex items-center justify-center gap-2">
                                <button
                                  onClick={() => setMoveFrom(t)}
                                  className="text-[11px] text-indigo-600 underline hover:text-indigo-800"
                                >
                                  Move / merge
                                </button>
                                <span className="text-[11px] text-zinc-300">
                                  ·
                                </span>
                                <button
                                  onClick={() => {
                                    if (confirm(`Clear table "${t.name}"?`))
                                      freeMut.mutate(t);
                                  }}
                                  className="text-[11px] text-zinc-400 underline hover:text-zinc-700"
                                >
                                  Clear
                                </button>
                              </div>
                            </div>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setSeatId(t.id)}
                              disabled={!enabled || t.outOfService}
                              className="w-full"
                            >
                              {t.outOfService ? "Out of service" : "Seat"}
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

      {/* Move / merge picker — choose the destination table for this tab. */}
      {moveFrom && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 p-4"
          onClick={() => setMoveFrom(null)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-zinc-200 px-5 py-3">
              <h2 className="text-base font-semibold text-zinc-900">
                Move or merge {moveFrom.name}
              </h2>
              <p className="text-[11px] text-zinc-500">
                Pick a <b>free</b> table to move this tab to, or an{" "}
                <b>occupied</b> one to merge both bills into it.
              </p>
            </div>
            <div className="max-h-80 overflow-y-auto p-3">
              {tables
                .filter((t) => t.id !== moveFrom.id && t.isActive)
                .map((t) => {
                  const busy = t.status === "OCCUPIED";
                  return (
                    <button
                      key={t.id}
                      disabled={moveMut.isPending || mergeMut.isPending}
                      onClick={() => {
                        if (busy) {
                          if (
                            confirm(
                              `Merge ${moveFrom.name} INTO ${t.name}? All items move onto ${t.name}'s bill and ${moveFrom.name} frees up.`,
                            )
                          )
                            mergeMut.mutate({
                              fromId: moveFrom.id,
                              intoId: t.id,
                            });
                        } else {
                          moveMut.mutate({ fromId: moveFrom.id, toId: t.id });
                        }
                      }}
                      className="mb-1.5 flex w-full items-center justify-between rounded-md border border-zinc-200 px-3 py-2 text-left hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-50"
                    >
                      <span className="text-sm font-medium text-zinc-900">
                        {t.name}
                        {t.area ? (
                          <span className="text-zinc-400"> · {t.area}</span>
                        ) : null}
                      </span>
                      <span
                        className={
                          busy
                            ? "rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800"
                            : "rounded px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-100 text-emerald-800"
                        }
                      >
                        {busy ? "Merge into" : "Move here"}
                      </span>
                    </button>
                  );
                })}
            </div>
            <div className="flex justify-end border-t border-zinc-100 px-5 py-3">
              <Button variant="outline" onClick={() => setMoveFrom(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {seatTable && (
        <SeatDialog
          table={seatTable}
          pending={seatMut.isPending}
          onConfirm={(input) => seatMut.mutate({ table: seatTable, input })}
          onClose={() => setSeatId(null)}
        />
      )}

      {actionsTable && (
        <TableActionsModal
          table={actionsTable}
          locationId={locationId}
          serviceEnabled={enabled}
          onClose={() => setActionsId(null)}
          onOpenTab={() => openTab(actionsTable)}
          onSeat={() => {
            // Both are z-50 modals — hand over rather than stack them.
            setActionsId(null);
            setSeatId(actionsTable.id);
          }}
          onMoveMerge={() => {
            setActionsId(null);
            setMoveFrom(actionsTable);
          }}
          onClear={() => freeMut.mutate(actionsTable)}
          onShowQr={() => setQrId(actionsTable.id)}
        />
      )}

      {qrTable && (
        <TableQrModal
          table={qrTable}
          locationId={locationId}
          onClose={() => setQrId(null)}
        />
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
