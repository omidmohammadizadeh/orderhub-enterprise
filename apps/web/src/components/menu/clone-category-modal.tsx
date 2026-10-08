"use client";

// "Clone category" — copy whole categories from another menu into this one.
// The server deep-copies every product: a brand-new product with a NEW PLU and
// its own option groups (new PLUs too), so marking a copy unavailable never
// touches the original menu.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Check, ChevronLeft, CopyPlus, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { menusClient } from "@/lib/api/menus.client";
import { locationsClient } from "@/lib/api/locations.client";

interface Props {
  open: boolean;
  /** The menu the categories are copied INTO */
  menuId: string;
  /** Its location — the source list defaults to menus there */
  locationId?: string;
  onClose: () => void;
}

export function CloneCategoryModal({ open, menuId, locationId, onClose }: Props) {
  const qc = useQueryClient();
  const [loc, setLoc] = useState<string>(locationId ?? "");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setLoc(locationId ?? "");
    setSourceId(null);
    setPicked(new Set());
  }, [open, locationId]);

  const locations = useQuery({
    queryKey: ["locations", "clone-category"],
    queryFn: () => locationsClient.list(),
    enabled: open,
    staleTime: 60_000,
  });
  const menus = useQuery({
    queryKey: ["menus", "clone-category-source", loc || "all"],
    queryFn: () => (loc ? menusClient.listMenusForLocation(loc) : menusClient.listMenusForTenant()),
    enabled: open,
  });
  const source = useQuery({
    queryKey: ["menu", sourceId],
    queryFn: () => menusClient.getMenu(sourceId!),
    enabled: open && !!sourceId,
  });

  const menuOptions = useMemo(
    () => ((menus.data ?? []) as any[]).filter((m) => m.id !== menuId && !m.deletedAt),
    [menus.data, menuId],
  );
  const categories = useMemo(
    () =>
      (((source.data as any)?.categories ?? []) as any[]).map((c) => ({
        id: String(c.id),
        name: String(c.name ?? ""),
        count: (c.items ?? []).length as number,
      })),
    [source.data],
  );
  const pickedProducts = categories.filter((c) => picked.has(c.id)).reduce((n, c) => n + c.count, 0);

  const clone = useMutation({
    mutationFn: () => menusClient.cloneCategories(menuId, { sourceMenuId: sourceId!, categoryIds: [...picked] }),
    onSuccess: (r) => {
      toast.success(
        `Cloned ${r.categories.length} ${r.categories.length === 1 ? "category" : "categories"} — ${r.itemsCopied} new products with new PLUs`,
      );
      qc.invalidateQueries({ queryKey: ["menu", menuId] });
      qc.invalidateQueries({ queryKey: ["catalog"] });
      onClose();
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? "Could not clone those categories"),
  });

  if (!open) return null;
  const sourceName = menuOptions.find((m) => m.id === sourceId)?.name ?? (source.data as any)?.name ?? "";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-zinc-100 px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            {sourceId && (
              <button
                type="button"
                onClick={() => {
                  setSourceId(null);
                  setPicked(new Set());
                }}
                className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100"
                aria-label="Back"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
                <CopyPlus className="h-4 w-4 text-orange-500" /> Clone category
              </h2>
              <p className="truncate text-xs text-zinc-500">
                {sourceId ? `Pick categories from "${sourceName}"` : "Pick the menu to copy categories from"}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          {!sourceId ? (
            <>
              <label className="mb-3 block">
                <span className="mb-1 block text-xs font-medium text-zinc-600">Location</span>
                <select
                  value={loc}
                  onChange={(e) => setLoc(e.target.value)}
                  className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm"
                >
                  <option value="">All locations</option>
                  {((locations.data ?? []) as any[]).map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              {menus.isPending ? (
                <div className="flex items-center justify-center py-10 text-sm text-zinc-500">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading menus…
                </div>
              ) : menuOptions.length === 0 ? (
                <p className="py-10 text-center text-sm text-zinc-500">No other menus here.</p>
              ) : (
                <ul className="space-y-1.5">
                  {menuOptions.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => setSourceId(m.id)}
                        className="flex w-full items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2.5 text-left hover:border-orange-300 hover:bg-orange-50"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-zinc-900">{m.name}</span>
                          <span className="block text-xs text-zinc-500">
                            {m._count?.categories ?? 0} categories · {String(m.status ?? "").toLowerCase()}
                          </span>
                        </span>
                        <ChevronLeft className="h-4 w-4 rotate-180 text-zinc-400" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : source.isPending ? (
            <div className="flex items-center justify-center py-10 text-sm text-zinc-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading categories…
            </div>
          ) : categories.length === 0 ? (
            <p className="py-10 text-center text-sm text-zinc-500">That menu has no categories.</p>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="text-zinc-500">{picked.size} selected</span>
                <button
                  type="button"
                  onClick={() =>
                    setPicked(picked.size === categories.length ? new Set() : new Set(categories.map((c) => c.id)))
                  }
                  className="font-medium text-orange-600 hover:underline"
                >
                  {picked.size === categories.length ? "Clear all" : "Select all"}
                </button>
              </div>
              <ul className="space-y-1.5">
                {categories.map((c) => {
                  const on = picked.has(c.id);
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() =>
                          setPicked((prev) => {
                            const next = new Set(prev);
                            if (next.has(c.id)) next.delete(c.id);
                            else next.add(c.id);
                            return next;
                          })
                        }
                        className={cn(
                          "flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left",
                          on ? "border-orange-400 bg-orange-50" : "border-zinc-200 hover:border-zinc-300",
                        )}
                      >
                        <span
                          className={cn(
                            "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border",
                            on ? "border-orange-500 bg-orange-500 text-white" : "border-zinc-300 text-transparent",
                          )}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900">{c.name}</span>
                        <span className="shrink-0 text-xs text-zinc-500">
                          {c.count} {c.count === 1 ? "product" : "products"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        {sourceId && (
          <footer className="space-y-2 border-t border-zinc-100 px-5 py-4">
            <p className="text-xs text-zinc-500">
              Each product is copied as a new product with a <span className="font-semibold">new PLU</span> and its
              own option groups — marking a copy unavailable never affects the original menu.
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" onClick={() => clone.mutate()} disabled={picked.size === 0 || clone.isPending}>
                {clone.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {clone.isPending
                  ? "Cloning…"
                  : `Clone ${picked.size || ""} ${picked.size === 1 ? "category" : "categories"}${
                      pickedProducts ? ` (${pickedProducts} products)` : ""
                    }`}
              </Button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
