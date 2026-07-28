"use client";

// Everything you can do to ONE table without leaving the floor plan: open or
// seat it, correct the covers/server, park it out of service, stop the
// internet booking it, or print its QR.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Ban, ArrowLeftRight, QrCode, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { tablesClient, type RestaurantTable } from "@/lib/api/tables.client";

const QUICK_COVERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export function TableActionsModal({
  table,
  locationId,
  serviceEnabled,
  onClose,
  onOpenTab,
  onSeat,
  onMoveMerge,
  onClear,
  onShowQr,
}: {
  table: RestaurantTable;
  locationId: string;
  serviceEnabled: boolean;
  onClose: () => void;
  onOpenTab: () => void;
  onSeat: () => void;
  onMoveMerge: () => void;
  onClear: () => void;
  onShowQr: () => void;
}) {
  const qc = useQueryClient();
  const occupied = table.status === "OCCUPIED";

  const [covers, setCovers] = useState<string>(
    table.covers != null ? String(table.covers) : "",
  );
  const [server, setServer] = useState(table.serverName ?? "");
  const [oosNote, setOosNote] = useState(table.outOfServiceNote ?? "");

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["tables", locationId] });

  const sittingMut = useMutation({
    mutationFn: () => {
      const n = Number(covers);
      return tablesClient.setSitting(table.id, {
        covers: covers.trim() === "" ? null : Math.max(0, Math.round(n || 0)),
        serverName: server.trim() || null,
      });
    },
    onSuccess: () => {
      refresh();
      toast.success("Saved");
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't save"),
  });

  const oosMut = useMutation({
    mutationFn: (on: boolean) =>
      tablesClient.setOutOfService(table.id, on, on ? oosNote : null),
    onSuccess: (_r, on) => {
      refresh();
      toast.success(on ? "Table out of service" : "Table back in service");
    },
    // The API refuses while a tab is open — surface its own wording, it
    // explains exactly what to do about it.
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ?? "Couldn't change the table's status",
      ),
  });

  const bookableMut = useMutation({
    mutationFn: (on: boolean) => tablesClient.setBookable(table.id, on),
    onSuccess: () => refresh(),
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? "Couldn't save"),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-zinc-200 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              {table.name}
              {table.area ? (
                <span className="font-normal text-zinc-400"> · {table.area}</span>
              ) : null}
            </h2>
            <p className="text-[11px] text-zinc-500">
              {table.seats ? `${table.seats} seats · ` : ""}
              {table.outOfService
                ? "Out of service"
                : occupied
                  ? "Occupied"
                  : "Free"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          {/* Primary action */}
          {table.outOfService ? (
            <div className="rounded-md bg-zinc-100 px-3 py-2 text-sm text-zinc-600">
              <Ban className="mr-1 inline h-3.5 w-3.5" />
              Out of service
              {table.outOfServiceNote ? ` — ${table.outOfServiceNote}` : ""}
            </div>
          ) : occupied ? (
            <div className="flex gap-2">
              <Button className="flex-1" onClick={onOpenTab}>
                Open tab
              </Button>
              <Button variant="outline" onClick={onMoveMerge}>
                <ArrowLeftRight className="mr-1 h-4 w-4" /> Move / merge
              </Button>
            </div>
          ) : (
            <Button
              className="w-full"
              onClick={onSeat}
              disabled={!serviceEnabled}
            >
              Seat this table
            </Button>
          )}

          {/* Covers + server — only meaningful while someone is sitting. */}
          {occupied && (
            <div className="rounded-lg border border-zinc-200 p-3">
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-700">
                <Users className="h-3.5 w-3.5" /> This sitting
              </h3>
              <label className="mb-1 block text-[11px] font-medium text-zinc-500">
                Covers
              </label>
              <div className="grid grid-cols-6 gap-1.5">
                {QUICK_COVERS.map((n) => (
                  <button
                    key={n}
                    onClick={() => setCovers(String(n))}
                    className={`h-11 rounded-md border text-sm font-medium ${
                      covers === String(n)
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                        : "border-zinc-200 text-zinc-700 hover:border-zinc-300"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <input
                type="number"
                min={0}
                value={covers}
                onChange={(e) => setCovers(e.target.value)}
                placeholder="Or type a number"
                className="mt-2 h-11 w-full rounded-md border border-zinc-200 px-3 text-sm"
              />
              <label className="mb-1 mt-3 block text-[11px] font-medium text-zinc-500">
                Server
              </label>
              <input
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="e.g. Amira"
                className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm"
              />
              <div className="mt-3 flex items-center justify-between">
                <button
                  onClick={() => {
                    if (confirm(`Clear table "${table.name}"?`)) onClear();
                  }}
                  className="text-[11px] text-zinc-400 underline hover:text-zinc-700"
                >
                  Clear table
                </button>
                <Button
                  size="sm"
                  onClick={() => sittingMut.mutate()}
                  loading={sittingMut.isPending}
                >
                  Save sitting
                </Button>
              </div>
            </div>
          )}

          {/* Availability */}
          <div className="space-y-3 rounded-lg border border-zinc-200 p-3">
            <label className="flex items-start gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={table.outOfService}
                disabled={oosMut.isPending}
                onChange={(e) => oosMut.mutate(e.target.checked)}
              />
              <span>
                Out of service
                <span className="block text-[11px] text-zinc-400">
                  Blocks walk-ins and online bookings.
                </span>
              </span>
            </label>
            {!table.outOfService && (
              <input
                value={oosNote}
                onChange={(e) => setOosNote(e.target.value)}
                placeholder="Reason (optional) — e.g. wobbly leg"
                className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm"
              />
            )}

            <label className="flex items-start gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={table.bookableOnline}
                disabled={bookableMut.isPending}
                onChange={(e) => bookableMut.mutate(e.target.checked)}
              />
              <span>
                Guests can book this table online
                <span className="block text-[11px] text-zinc-400">
                  Turn off for tables you keep back for walk-ins.
                </span>
              </span>
            </label>
          </div>

          <Button variant="outline" className="w-full" onClick={onShowQr}>
            <QrCode className="mr-1 h-4 w-4" /> Table QR
            {table.qrToken ? (
              <span className="ml-1 text-[11px] text-zinc-400">
                · {table.qrToken}
              </span>
            ) : null}
          </Button>
        </div>
      </div>
    </div>
  );
}
