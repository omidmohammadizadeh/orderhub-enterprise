"use client";

// Seating a table is the single most repeated action of a service, so this
// dialog opens pre-filled (covers = the table's seats, server = whoever
// seated the last table on this device) and one tap on "Seat" is enough.

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RestaurantTable, SittingInput } from "@/lib/api/tables.client";

const SERVER_KEY = "oh.tables.lastServer";
const QUICK_COVERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export function SeatDialog({
  table,
  pending,
  onConfirm,
  onClose,
}: {
  table: RestaurantTable;
  pending: boolean;
  onConfirm: (input: SittingInput) => void;
  onClose: () => void;
}) {
  const [covers, setCovers] = useState<string>(
    table.seats ? String(table.seats) : "2",
  );
  const [server, setServer] = useState("");

  // Remembering the server across tables saves a dozen keystrokes a shift.
  useEffect(() => {
    try {
      setServer(localStorage.getItem(SERVER_KEY) ?? "");
    } catch {
      /* private mode — not worth failing over */
    }
  }, []);

  const submit = () => {
    const n = Number(covers);
    try {
      if (server.trim()) localStorage.setItem(SERVER_KEY, server.trim());
      else localStorage.removeItem(SERVER_KEY);
    } catch {
      /* ignore */
    }
    onConfirm({
      covers: Number.isFinite(n) && n > 0 ? Math.round(n) : null,
      serverName: server.trim() || null,
    });
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">
            Seat {table.name}
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-700">
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
              min={1}
              value={covers}
              onChange={(e) => setCovers(e.target.value)}
              placeholder="Or type a number"
              className="mt-2 h-11 w-full rounded-md border border-zinc-200 px-3 text-sm"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-700">
              Server{" "}
              <span className="font-normal text-zinc-400">(optional)</span>
            </label>
            <input
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="e.g. Amira"
              className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Seat &amp; take order
          </Button>
        </div>
      </div>
    </div>
  );
}
