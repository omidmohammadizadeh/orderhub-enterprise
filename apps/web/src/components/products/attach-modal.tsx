"use client";

// Reusable "Add Existing" search modal. Mirrors Deliverect's layout:
// title, search bar, scrollable checkbox list, Cancel + Done footer.
//
// Generic on the row shape so the same modal serves both
// "Add Modifier Groups" (from product editor) and "Add Modifiers"
// (from modifier-group editor). Callers pass in the candidate rows,
// the set of IDs that are currently attached (to seed the checkboxes),
// and a confirm callback that receives the FINAL desired set when
// the user clicks Done.

import { useEffect, useMemo, useState } from "react";
import { X, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface AttachRow {
  id: string;
  /** Display name on the row. */
  name: string;
  /** Small monospace tag below name (PLU / external id). */
  subtitle?: string;
  /** Extra right-aligned hint like "0 modifiers". */
  meta?: string;
}

interface Props {
  open: boolean;
  title: string;
  rows: AttachRow[];
  /** IDs already attached — appear pre-ticked. */
  initiallyAttachedIds: string[];
  onConfirm: (selectedIds: string[]) => void;
  onCancel: () => void;
  /** Placeholder for the search box; defaults to a sensible value. */
  searchPlaceholder?: string;
}

export function AttachModal({
  open,
  title,
  rows,
  initiallyAttachedIds,
  onConfirm,
  onCancel,
  searchPlaceholder = "Search by name or PLU...",
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  // Re-seed selection every time the modal opens so the user always
  // sees the current attached state, not the previous session's.
  useEffect(() => {
    if (open) {
      setSelected(new Set(initiallyAttachedIds));
      setSearch("");
    }
  }, [open, initiallyAttachedIds]);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.subtitle ?? "").toLowerCase().includes(q),
    );
  }, [rows, search]);

  if (!open) return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    // z-index sits above the form so it covers the underlying scroll
    // body. Clicking the backdrop or the X cancels.
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-zinc-100">
          <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
          <button
            onClick={onCancel}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="pl-9 h-9 text-sm"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-3 border-y border-zinc-100">
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-zinc-400">
              {rows.length === 0
                ? "Nothing in the catalog yet."
                : "No results match your search."}
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {filtered.map((r) => {
                const isOn = selected.has(r.id);
                return (
                  <li key={r.id}>
                    <label
                      className={`flex items-center gap-3 px-3 py-3 cursor-pointer rounded-md transition-colors ${
                        isOn ? "bg-orange-50/50" : "hover:bg-zinc-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isOn}
                        onChange={() => toggle(r.id)}
                        className="h-4 w-4 flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-zinc-900 truncate">
                          {r.name}
                        </p>
                        {r.subtitle && (
                          <p className="text-[11px] font-mono text-zinc-500 truncate">
                            {r.subtitle}
                            {r.meta ? ` · ${r.meta}` : ""}
                          </p>
                        )}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => onConfirm(Array.from(selected))}
            className="bg-zinc-900 hover:bg-zinc-800 text-white"
          >
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
