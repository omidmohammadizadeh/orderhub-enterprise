"use client";

// Full-screen store picker for marketplace connect flows.
//
// The inline list this replaces became unusable once an account held dozens
// of stores: a narrow drawer column showing 40+ near-identically-named sites
// ("BURGERZ AND FRIEZ-LONDON ROAD", "BURGERZ AND FRIEZ-NEWPORT", …) with no
// way to search. Picking the wrong one links a brand to someone else's shop,
// so this is a step that has to be easy to get right.
//
// Search matches name, address AND store id — operators are usually pasting
// or eyeballing an id from the Uber/HubRise portal.

import { useMemo, useState } from "react";
import { Loader2, MapPin, Search, X } from "lucide-react";

export interface PickableStore {
  storeId: string;
  name?: string | null;
  address?: string | null;
}

export function StorePickerModal({
  title,
  stores,
  busy,
  onPick,
  onClose,
  onRefresh,
}: {
  title: string;
  stores: PickableStore[];
  busy?: boolean;
  onPick: (storeId: string) => void;
  onClose: () => void;
  onRefresh?: () => void;
}) {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return stores;
    // Match every term independently so "burgerz newport" finds a store
    // whose name and address each contain one of the words.
    const terms = needle.split(/\s+/);
    return stores.filter((s) => {
      const hay = `${s.name ?? ""} ${s.address ?? ""} ${s.storeId}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [stores, q]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
            <p className="text-xs text-zinc-500">
              {stores.length} store{stores.length === 1 ? "" : "s"} in this
              account
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="border-b border-zinc-200 px-5 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, address or store ID…"
              className="w-full rounded-md border border-zinc-200 py-2 pl-9 pr-3 text-sm outline-none focus:border-zinc-900"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {filtered.length === 0 ? (
            <p className="py-10 text-center text-xs text-zinc-500">
              No stores match “{q}”.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {filtered.map((s) => {
                const isSel = selected === s.storeId;
                return (
                  <button
                    key={s.storeId}
                    type="button"
                    onClick={() => setSelected(s.storeId)}
                    className={
                      "rounded-lg border p-3 text-left transition-colors " +
                      (isSel
                        ? "border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900"
                        : "border-zinc-200 hover:border-zinc-400")
                    }
                  >
                    <p className="text-sm font-semibold text-zinc-900">
                      {s.name || s.storeId}
                    </p>
                    {s.address && (
                      <p className="mt-1 flex items-start gap-1 text-xs text-zinc-500">
                        <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>{s.address}</span>
                      </p>
                    )}
                    {/* The id is what actually gets linked, so show it —
                        two shops in a chain often share a name. */}
                    <p className="mt-1 font-mono text-[10px] text-zinc-400">
                      {s.storeId}
                    </p>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-zinc-200 px-5 py-3">
          {onRefresh ? (
            <button
              onClick={onRefresh}
              disabled={busy}
              className="text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-50"
            >
              Refresh stores
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Cancel
            </button>
            <button
              onClick={() => selected && onPick(selected)}
              disabled={!selected || busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-40"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              Connect store
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
