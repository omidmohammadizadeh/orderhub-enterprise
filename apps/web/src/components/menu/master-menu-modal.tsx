"use client";

// Phase BC — Master Menu. HubRise only connects one menu per location, but
// a kitchen can sell several brands. This picks a set of this location's
// existing menus (typically one per brand) and merges their categories +
// items into one new menu, ready to publish to HubRise as the location's
// single connected catalog. Items keep their own brand (MenuItem.brandId) —
// nothing is duplicated, only re-linked — and the new menu is seeded with
// per-brand pricing variants so HubRise's per-brand restrictions work
// straight away.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { X, Layers, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { menusClient, type Menu, type Brand } from "@/lib/api/menus.client";

interface Props {
  open: boolean;
  locationId: string;
  menus: Menu[];
  brands: Brand[];
  onCreated: (menu: Menu) => void;
  onCancel: () => void;
}

export function MasterMenuModal({
  open,
  locationId,
  menus,
  brands,
  onCreated,
  onCancel,
}: Props) {
  const [name, setName] = useState("Master Menu");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const brandNameById = new Map(brands.map((b) => [b.id, b.name]));

  const createMutation = useMutation({
    mutationFn: () =>
      menusClient.createMasterMenu(locationId, {
        name: name.trim(),
        sourceMenuIds: Array.from(selected),
      }),
    onSuccess: (menu) => {
      onCreated(menu);
      setName("Master Menu");
      setSelected(new Set());
    },
  });

  if (!open) return null;

  const toggle = (menuId: string) => {
    const next = new Set(selected);
    if (next.has(menuId)) next.delete(menuId);
    else next.add(menuId);
    setSelected(next);
  };

  const canSave = name.trim().length > 0 && selected.size > 0 && !createMutation.isPending;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="my-8 w-full max-w-xl rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 p-5">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-violet-100 text-violet-700">
              <Layers className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold text-zinc-900">Master menu</h2>
              <p className="text-[11px] text-zinc-500">
                Combine this location&apos;s menus into one, for HubRise
              </p>
            </div>
          </div>
          <button onClick={onCancel} className="text-zinc-400 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-700">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Master Menu" />
          </label>

          <div>
            <span className="mb-1.5 block text-sm font-medium text-zinc-700">
              Menus to combine
            </span>
            {menus.length === 0 ? (
              <p className="rounded-md border border-dashed border-zinc-200 bg-zinc-50 px-3 py-6 text-center text-xs text-zinc-500">
                No other menus exist at this location yet.
              </p>
            ) : (
              <div className="max-h-72 space-y-1.5 overflow-y-auto">
                {menus.map((m) => {
                  const checked = selected.has(m.id);
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
                        <span className="truncate text-sm font-medium text-zinc-900">
                          {m.name}
                        </span>
                        <span className="flex shrink-0 items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600">
                          <Store className="h-3 w-3" />
                          {brandNameById.get(m.brandId) ?? "Unknown brand"}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <p className="rounded-md bg-zinc-50 px-3 py-2 text-[11px] text-zinc-500">
            Each item keeps its own brand — nothing is duplicated. The new
            menu is seeded with per-brand pricing variants (Uber Eats,
            Deliveroo, Just Eat) so HubRise shows each brand&apos;s connector
            only its own products. Edit variants any time from the menu&apos;s
            settings.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-100 p-4">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => createMutation.mutate()}
            disabled={!canSave}
            className="bg-violet-600 text-white hover:bg-violet-700"
          >
            {createMutation.isPending ? "Creating…" : "Create master menu"}
          </Button>
        </div>
      </div>
    </div>
  );
}
