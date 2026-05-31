"use client";

// Phase AN — Standalone Brands drawer opened from the location card.
// Lists every brand attached to this location and renders the
// BrandPlatformGrid (6 platform rows) per brand. Includes a quick-create
// form at the bottom.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { brandsClient } from "@/lib/api/locations.client";
import { BrandPlatformGrid } from "./brand-platform-grid";

interface Props {
  locationId: string;
  onClose: () => void;
}

export function LocationBrandsDrawer({ locationId, onClose }: Props) {
  const qc = useQueryClient();
  const brandsQuery = useQuery({
    queryKey: ["brands", "location", locationId],
    queryFn: () => brandsClient.list(locationId),
  });

  const [newName, setNewName] = useState("");
  const [newCuisine, setNewCuisine] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      brandsClient.create({
        name: newName,
        cuisine: newCuisine || undefined,
        primaryLocationId: locationId,
      }),
    onSuccess: () => {
      setNewName("");
      setNewCuisine("");
      qc.invalidateQueries({ queryKey: ["brands"] });
    },
    onError: (e: any) => setErr(e?.response?.data?.message ?? e.message ?? "Failed"),
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-xl flex-col overflow-hidden bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">Brands</h2>
            <p className="text-xs text-zinc-500">Brands operating from this location</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {brandsQuery.isLoading ? (
            <p className="py-4 text-center text-xs text-zinc-400">Loading…</p>
          ) : (brandsQuery.data ?? []).length === 0 ? (
            <div className="rounded-md border border-dashed border-zinc-200 px-4 py-8 text-center">
              <p className="text-sm font-medium text-zinc-700">No brands yet</p>
              <p className="mt-1 text-xs text-zinc-500">
                Create a brand below. Channel connections appear once a brand exists.
              </p>
            </div>
          ) : (
            // Phase AN follow-up: brand-platform connections sit BELOW the
            // brand they belong to and only appear once a real brand has
            // been created. Each brand keeps its own connections — they
            // never bleed across brands or locations.
            (brandsQuery.data ?? []).map((b) => (
              <details
                key={b.id}
                className="overflow-hidden rounded-md border border-zinc-200"
                open
              >
                <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-zinc-900 hover:bg-zinc-50">
                  {b.name}
                  {b.cuisine && (
                    <span className="ml-2 text-[10px] text-zinc-500">· {b.cuisine}</span>
                  )}
                </summary>
                <div className="border-t border-zinc-200 p-3">
                  <p className="mb-2 text-[10px] uppercase tracking-wider text-zinc-400">
                    Channel connections for {b.name}
                  </p>
                  <BrandPlatformGrid brandId={b.id} locationId={locationId} />
                </div>
              </details>
            ))
          )}
        </div>

        <footer className="border-t border-zinc-200 p-3 space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Add brand
          </p>
          <div className="flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Brand name"
              className="flex-1 rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
            />
            <input
              value={newCuisine}
              onChange={(e) => setNewCuisine(e.target.value)}
              placeholder="Cuisine"
              className="w-32 rounded-md border border-zinc-200 px-2 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
            />
            <button
              onClick={() => create.mutate()}
              disabled={create.isPending || !newName}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {create.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
            </button>
          </div>
          {err && <p className="text-[11px] text-red-600">{err}</p>}
        </footer>
      </div>
    </div>
  );
}
