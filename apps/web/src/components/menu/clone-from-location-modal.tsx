"use client";

// "Clone from another location" — pick one of your other locations, pick a menu
// there, and clone it into the CURRENT location as a new, fully independent
// draft (new PLUs, own items). Reuses the same deep-clone the single-location
// "Clone" action uses, just homed to a different target location.

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Copy, Loader2, ChevronRight, Check } from "lucide-react";
import { menusClient } from "@/lib/api/menus.client";
import { locationsClient } from "@/lib/api/locations.client";

interface Props {
  open: boolean;
  targetLocationId: string; // the location we clone INTO (the current one)
  onClose: () => void;
  onCloned: () => void;
}

export function CloneFromLocationModal({
  open,
  targetLocationId,
  onClose,
  onCloned,
}: Props) {
  const qc = useQueryClient();
  const [sourceLocationId, setSourceLocationId] = useState<string>("");
  const [selectedMenuId, setSelectedMenuId] = useState<string>("");
  const [name, setName] = useState<string>("");

  useEffect(() => {
    if (open) {
      setSourceLocationId("");
      setSelectedMenuId("");
      setName("");
    }
  }, [open]);

  const locationsQuery = useQuery({
    queryKey: ["locations", "list"],
    queryFn: () => locationsClient.list(),
    enabled: open,
  });

  // Other locations only — you clone FROM another location INTO the current one.
  const otherLocations = (locationsQuery.data ?? []).filter(
    (l: any) => l.id !== targetLocationId,
  );

  const menusQuery = useQuery({
    queryKey: ["menus", "location", sourceLocationId],
    queryFn: () => menusClient.listMenusForLocation(sourceLocationId),
    enabled: open && !!sourceLocationId,
  });

  const clone = useMutation({
    mutationFn: () => {
      const src = (menusQuery.data ?? []).find((m: any) => m.id === selectedMenuId);
      const cloneName = name.trim() || `${src?.name ?? "Menu"} (copy)`;
      return menusClient.cloneMenu(selectedMenuId, cloneName, targetLocationId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["menus"] });
      onCloned();
      onClose();
    },
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 p-5">
          <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
            <Copy className="h-4 w-4" /> Clone from another location
          </h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {/* Step 1 — source location */}
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-500">
              1. Location to copy from
            </label>
            <select
              value={sourceLocationId}
              onChange={(e) => {
                setSourceLocationId(e.target.value);
                setSelectedMenuId("");
              }}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            >
              <option value="">Select a location…</option>
              {otherLocations.map((l: any) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            {locationsQuery.isSuccess && otherLocations.length === 0 && (
              <p className="mt-1 text-xs text-zinc-400">
                You don’t have another location to copy from.
              </p>
            )}
          </div>

          {/* Step 2 — source menu */}
          {sourceLocationId && (
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">
                2. Menu to clone
              </label>
              {menusQuery.isLoading ? (
                <div className="py-6 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-zinc-300" />
                </div>
              ) : !menusQuery.data?.length ? (
                <p className="rounded-md border border-zinc-200 px-3 py-4 text-center text-sm text-zinc-400">
                  No menus at that location.
                </p>
              ) : (
                <div className="max-h-56 space-y-1.5 overflow-y-auto">
                  {menusQuery.data.map((m: any) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        setSelectedMenuId(m.id);
                        if (!name.trim()) setName(`${m.name} (copy)`);
                      }}
                      className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition ${
                        selectedMenuId === m.id
                          ? "border-violet-500 bg-violet-50"
                          : "border-zinc-200 hover:bg-zinc-50"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-zinc-900">
                          {m.name}
                        </span>
                        <span className="text-xs text-zinc-400">
                          {m.status ?? "DRAFT"}
                          {typeof m._count?.categories === "number"
                            ? ` · ${m._count.categories} categories`
                            : ""}
                        </span>
                      </span>
                      {selectedMenuId === m.id ? (
                        <Check className="h-4 w-4 shrink-0 text-violet-600" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-zinc-300" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 3 — name */}
          {selectedMenuId && (
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">
                3. Name for the new menu
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Main menu (copy)"
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              />
              <p className="mt-1 text-[11px] text-zinc-400">
                Creates an independent copy (fresh PLUs, its own items) under this
                location. It won’t affect the original.
              </p>
            </div>
          )}

          {clone.isError && (
            <p className="text-xs text-red-600">
              {(clone.error as any)?.response?.data?.message ??
                "Couldn’t clone the menu."}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
            >
              Cancel
            </button>
            <button
              onClick={() => clone.mutate()}
              disabled={!selectedMenuId || clone.isPending}
              className="flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {clone.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Clone into this location
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
