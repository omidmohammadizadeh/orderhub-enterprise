"use client";

// "Apply to other items" — the antidote to attaching the same modifier group
// to nineteen pizzas by hand.
//
// Two things are being applied and they behave differently, which the modal
// says out loud rather than leaving the operator to find out later:
//
//   • Modifier groups are LINKED. Every item ends up pointing at the same
//     group, so editing its options later updates all of them at once. That
//     is what "use the same group" ought to mean.
//   • Sizes are COPIED, with fresh PLUs per item. They are independent from
//     that moment on — changing a price here won't change it there.
//
// Scoped to the menu the operator is editing, per the brief: the picker lists
// that menu's items and nothing else.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search, Check, X, Layers } from "lucide-react";
import { menusClient } from "@/lib/api/menus.client";

export interface ApplyTarget {
  id: string;
  name: string;
  categoryName: string;
}

export function ApplyToItemsModal({
  menuId,
  sourceItemId,
  sourceItemName,
  groupNames,
  skuCount,
  applying,
  error,
  onApply,
  onClose,
}: {
  menuId: string;
  sourceItemId: string;
  sourceItemName: string;
  /** Names of the modifier groups about to be linked. Empty = sizes only. */
  groupNames: string[];
  /** How many sizes will be copied. 0 = groups only. */
  skuCount: number;
  applying: boolean;
  error: string | null;
  onApply: (targetItemIds: string[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const { data: menu, isLoading } = useQuery({
    queryKey: ["menu", menuId],
    queryFn: () => menusClient.getMenu(menuId),
  });

  // Flattened, source item removed — offering to apply an item to itself is
  // just a way to confuse someone.
  const targets: ApplyTarget[] = useMemo(() => {
    const out: ApplyTarget[] = [];
    for (const cat of menu?.categories ?? []) {
      for (const link of cat.items ?? []) {
        if (!link.item || link.item.id === sourceItemId) continue;
        out.push({
          id: link.item.id,
          name: link.item.name,
          categoryName: cat.name,
        });
      }
    }
    return out;
  }, [menu, sourceItemId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.categoryName.toLowerCase().includes(q),
    );
  }, [targets, search]);

  // Select-all applies to what's VISIBLE, not the whole menu — otherwise
  // searching "pizza" and hitting the box would quietly tick the drinks too.
  const allVisibleSelected =
    filtered.length > 0 && filtered.every((t) => selected.has(t.id));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const t of filtered) next.delete(t.id);
      else for (const t of filtered) next.add(t.id);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-zinc-100 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-900">
              Apply to other items
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              From <span className="font-medium">{sourceItemName || "this item"}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* What's about to happen, in the operator's words. */}
        <div className="border-b border-zinc-100 bg-zinc-50 px-4 py-2.5 text-xs text-zinc-600">
          <div className="flex items-start gap-2">
            <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" />
            <div className="space-y-1">
              {groupNames.length > 0 && (
                <p>
                  <span className="font-medium text-zinc-800">
                    {groupNames.length} modifier group
                    {groupNames.length === 1 ? "" : "s"}
                  </span>{" "}
                  ({groupNames.join(", ")}) will be attached. They stay linked —
                  editing the group later updates every item at once.
                </p>
              )}
              {skuCount > 0 && (
                <p>
                  <span className="font-medium text-zinc-800">
                    {skuCount} size{skuCount === 1 ? "" : "s"}
                  </span>{" "}
                  will be copied, each item getting its own product codes.
                  Copies are independent — later price changes don&apos;t follow.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="border-b border-zinc-100 px-4 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search this menu…"
              className="w-full rounded-md border border-zinc-200 py-1.5 pl-8 pr-3 text-xs focus:border-zinc-900 focus:outline-none"
            />
          </div>
          {filtered.length > 0 && (
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-zinc-600">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleAllVisible}
                className="h-3.5 w-3.5 rounded border-zinc-300"
              />
              Select all {search.trim() ? "matching" : ""} ({filtered.length})
            </label>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex h-32 items-center justify-center text-zinc-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-4 py-10 text-center text-xs text-zinc-400">
              {targets.length === 0
                ? "This menu has no other items yet."
                : "No items match that search."}
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {filtered.map((t) => {
                const on = selected.has(t.id);
                return (
                  <li key={t.id}>
                    <label className="flex cursor-pointer items-center gap-2.5 px-4 py-2 hover:bg-zinc-50">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggle(t.id)}
                        className="h-3.5 w-3.5 rounded border-zinc-300"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-zinc-800">
                          {t.name}
                        </span>
                        <span className="block truncate text-[11px] text-zinc-400">
                          {t.categoryName}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {error && (
          <p className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">
            {error}
          </p>
        )}

        <footer className="flex items-center justify-between gap-3 border-t border-zinc-100 px-4 py-3">
          <span className="text-xs text-zinc-500">
            {selected.size} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={applying}
              className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onApply([...selected])}
              disabled={applying || selected.size === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {applying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Attach to {selected.size || ""} item
              {selected.size === 1 ? "" : "s"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
