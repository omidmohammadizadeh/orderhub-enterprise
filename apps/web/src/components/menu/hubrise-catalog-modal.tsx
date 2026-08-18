"use client";

// HubRise composed catalog.
//
// HubRise allows one catalog per location and charges per location, so every
// brand in a kitchen shares it. Until now that meant hand-building a Master
// Menu and rebuilding it whenever a brand changed something. Here the operator
// just names the brand menus that make up the catalog; after that they edit
// each brand's own menu and press publish on it, and we republish every member
// together — so no brand ever drops out of the catalog and nobody has to
// re-select their variant inside HubRise.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Layers, Store, AlertTriangle } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { menusClient, type HubRiseCatalogMenu } from "@/lib/api/menus.client";

interface Props {
  open: boolean;
  locationId: string;
  onClose: () => void;
}

export function HubRiseCatalogModal({ open, locationId, onClose }: Props) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string> | null>(null);

  const listQuery = useQuery({
    queryKey: ["hubrise-catalog", locationId],
    queryFn: () => menusClient.listHubRiseCatalogMenus(locationId),
    enabled: open && !!locationId,
  });

  // Seed the checkboxes from the server once per open.
  useEffect(() => {
    if (!open) setSelected(null);
    else if (selected === null && listQuery.data) {
      setSelected(
        new Set(listQuery.data.filter((m) => m.inHubRiseCatalog).map((m) => m.id)),
      );
    }
  }, [open, listQuery.data, selected]);

  const saveMutation = useMutation({
    mutationFn: () =>
      menusClient.setHubRiseCatalogMenus(locationId, Array.from(selected ?? [])),
    onSuccess: (rows) => {
      qc.invalidateQueries({ queryKey: ["hubrise-catalog", locationId] });
      qc.invalidateQueries({ queryKey: ["menus"] });
      const n = rows.filter((r) => r.inHubRiseCatalog).length;
      toast.success(
        n === 0
          ? "HubRise catalog is no longer composed — each menu publishes on its own again."
          : `HubRise catalog now composed from ${n} menu${n === 1 ? "" : "s"}.`,
      );
      onClose();
    },
    onError: (err: any) =>
      toast.error(
        `Couldn't save: ${err?.response?.data?.message ?? err?.message ?? "unknown error"}`,
      ),
  });

  const menus = listQuery.data ?? [];
  const picked = selected ?? new Set<string>();

  // Two brands in one catalog need one menu each. Two menus for the SAME brand
  // means that brand's products go in twice.
  const duplicateBrands = useMemo(() => {
    const byBrand = new Map<string, number>();
    for (const m of menus) {
      if (!picked.has(m.id)) continue;
      byBrand.set(m.brandId, (byBrand.get(m.brandId) ?? 0) + 1);
    }
    return menus
      .filter((m) => picked.has(m.id) && (byBrand.get(m.brandId) ?? 0) > 1)
      .map((m) => m.brandName ?? m.brandId);
  }, [menus, picked]);

  // The publish guard refuses an empty member outright, so warn here first.
  const emptyPicked = menus.filter((m) => picked.has(m.id) && m.productCount === 0);

  if (!open) return null;

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm">
      <div className="my-8 w-full max-w-xl rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 p-5">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-violet-100 text-violet-700">
              <Layers className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold text-zinc-900">HubRise catalog</h2>
              <p className="text-[11px] text-zinc-500">
                Which brand menus make up this location&apos;s one HubRise catalog
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <p className="rounded-md bg-violet-50 px-3 py-2 text-[11px] leading-relaxed text-violet-900">
            Tick one menu per brand. After that, edit any brand&apos;s own menu
            and press publish on it — every ticked menu is republished together
            as one catalog, so no brand disappears and nobody has to re-pick
            their variant in HubRise. Leave everything unticked to keep
            publishing menus one at a time, as before.
          </p>

          {listQuery.isLoading ? (
            <p className="px-3 py-6 text-center text-xs text-zinc-500">Loading menus…</p>
          ) : menus.length === 0 ? (
            <p className="rounded-md border border-dashed border-zinc-200 bg-zinc-50 px-3 py-6 text-center text-xs text-zinc-500">
              No menus at this location yet.
            </p>
          ) : (
            <div className="max-h-80 space-y-1.5 overflow-y-auto">
              {menus.map((m: HubRiseCatalogMenu) => {
                const checked = picked.has(m.id);
                return (
                  <label
                    key={m.id}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                      checked
                        ? "border-violet-400 bg-violet-50"
                        : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(m.id)}
                      className="h-4 w-4 rounded border-zinc-300 text-violet-600 focus:ring-violet-500"
                    />
                    <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-zinc-900">
                          {m.name}
                        </span>
                        <span
                          className={`block text-[11px] ${
                            m.productCount === 0 ? "text-amber-600" : "text-zinc-500"
                          }`}
                        >
                          {m.productCount} product{m.productCount === 1 ? "" : "s"}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600">
                        <Store className="h-3 w-3" />
                        {m.brandName ?? "Unknown brand"}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {emptyPicked.length > 0 && (
            <Warning>
              {emptyPicked.map((m) => `"${m.name}"`).join(", ")} has no products.
              Publishing is refused while an empty menu is in the catalog, because
              that brand&apos;s storefront would go dark.
            </Warning>
          )}
          {duplicateBrands.length > 0 && (
            <Warning>
              You&apos;ve ticked more than one menu for{" "}
              {Array.from(new Set(duplicateBrands)).join(", ")}. That brand&apos;s
              products would be published twice — pick just one menu per brand.
            </Warning>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-100 p-4">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={selected === null || saveMutation.isPending}
            className="bg-violet-600 text-white hover:bg-violet-700"
          >
            {saveMutation.isPending ? "Saving…" : "Save catalog"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
