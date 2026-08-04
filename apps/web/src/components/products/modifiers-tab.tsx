"use client";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Sliders, ImageIcon, Trash2, Copy } from "lucide-react";
import {
  modifierGroupsClient,
  modifiersClient,
  type CatalogModifier,
} from "@/lib/api/catalog.client";
import { Button } from "@/components/ui/button";
import { CatalogEmptyState } from "./empty-state";
import { ModifierForm } from "./modifier-form";

interface Props {
  brandId: string;
  /** Phase AP — when set, list modifiers belonging to this location only. */
  locationId?: string | null;
  search: string;
}

// Modifiers live inside ModifierGroups (each option has a groupId). To
// surface "all modifiers at this location" we fetch the location's
// modifier groups (Phase AP location-scoped lookup) and flatten the
// options. Falls back to brand-scoped when no location is selected,
// which only happens on the initial page load before the operator
// picks a location.
export function ModifiersTab({ brandId, locationId, search }: Props) {
  const qc = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // The cache key includes locationId so switching the location selector
  // triggers a fresh fetch and the list never shows stale entries from
  // another location.
  const scopeKey = locationId ? `loc:${locationId}` : `brand:${brandId}`;
  const { data: groups = [], isLoading } = useQuery({
    queryKey: ["catalog", "modifier-groups-with-options", scopeKey],
    queryFn: () =>
      locationId
        ? modifierGroupsClient.listForLocation(locationId)
        : modifierGroupsClient.list(brandId),
    enabled: !!brandId || !!locationId,
  });

  const all: Array<CatalogModifier & { groupName: string }> = useMemo(() => {
    return groups.flatMap((g) =>
      (g.options ?? []).map((opt) => ({ ...opt, groupName: g.name })),
    );
  }, [groups]);

  const filtered = useMemo(() => {
    if (!search.trim()) return all;
    const q = search.toLowerCase();
    return all.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        (m.plu ?? "").toLowerCase().includes(q),
    );
  }, [all, search]);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => modifiersClient.remove(id),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["catalog", "modifier-groups-with-options", scopeKey],
      }),
  });

  // Copy sits in the same group with a fresh PLU, then opens for renaming.
  const duplicateMutation = useMutation({
    mutationFn: (id: string) => modifiersClient.duplicate(id),
    onSuccess: (created) => {
      qc.invalidateQueries({
        queryKey: ["catalog", "modifier-groups-with-options", scopeKey],
      });
      if (created?.id) setEditingId(created.id);
    },
  });

  if (isLoading)
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 rounded-lg bg-zinc-100 animate-pulse" />
        ))}
      </div>
    );

  if (isCreating || editingId) {
    return (
      <ModifierForm
        brandId={brandId}
        groups={groups}
        modifierId={editingId ?? undefined}
        onCancel={() => {
          setIsCreating(false);
          setEditingId(null);
        }}
        onSaved={() => {
          setIsCreating(false);
          setEditingId(null);
          qc.invalidateQueries({
            queryKey: ["catalog", "modifier-groups-with-options", scopeKey],
          });
        }}
      />
    );
  }

  if (all.length === 0)
    return (
      <CatalogEmptyState
        icon={Sliders}
        title="No modifiers yet"
        description="Modifiers are the toppings, sauces, sizes, and extras customers add to a product. Create a modifier group first, then add modifiers to it."
        ctaLabel="Create modifier"
        onCta={() => setIsCreating(true)}
      />
    );

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => setIsCreating(true)}
          className="bg-orange-500 hover:bg-orange-600 text-white"
        >
          <Plus className="h-4 w-4 mr-1.5" />
          Create modifier
        </Button>
      </div>
      <div className="rounded-xl border border-zinc-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-zinc-500">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">Name</th>
              <th className="text-left font-medium px-4 py-2.5">Group</th>
              <th className="text-left font-medium px-4 py-2.5">PLU</th>
              <th className="text-right font-medium px-4 py-2.5">Price</th>
              <th className="w-32" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {filtered.map((m) => (
              <tr key={m.id} className="hover:bg-zinc-50">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    {m.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={m.imageUrl}
                        alt=""
                        className="h-9 w-9 rounded object-cover flex-shrink-0"
                      />
                    ) : (
                      <div className="h-9 w-9 rounded bg-zinc-100 flex-shrink-0 flex items-center justify-center">
                        <ImageIcon className="h-3.5 w-3.5 text-zinc-300" />
                      </div>
                    )}
                    <span className="font-medium text-zinc-900">{m.name}</span>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-xs text-zinc-600">{m.groupName}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-zinc-600">
                  {m.plu ?? "—"}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  £{Number(m.priceAdjustment).toFixed(2)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="inline-flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingId(m.id)}
                      className="h-7 px-2 text-xs"
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => duplicateMutation.mutate(m.id)}
                      disabled={duplicateMutation.isPending}
                      className="h-7 px-2 text-zinc-400 hover:text-zinc-900"
                      title="Duplicate — creates a new modifier with a new PLU"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (
                          confirm(
                            `Delete modifier "${m.name}"? Every group it's attached to will lose it.`,
                          )
                        ) {
                          deleteMutation.mutate(m.id);
                        }
                      }}
                      disabled={deleteMutation.isPending}
                      className="h-7 px-2 text-zinc-400 hover:text-red-600"
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-zinc-400">
                  No modifiers match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
