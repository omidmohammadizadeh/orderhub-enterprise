"use client";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, ListTree, Trash2 } from "lucide-react";
import { modifierGroupsClient } from "@/lib/api/catalog.client";
import { Button } from "@/components/ui/button";
import { CatalogEmptyState } from "./empty-state";
import { ModifierGroupForm } from "./modifier-group-form";

interface Props {
  brandId: string;
  search: string;
}

export function ModifierGroupsTab({ brandId, search }: Props) {
  const qc = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data: groups = [], isLoading } = useQuery({
    queryKey: ["catalog", "modifier-groups", brandId],
    queryFn: () => modifierGroupsClient.list(brandId),
    enabled: !!brandId,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => modifierGroupsClient.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["catalog", "modifier-groups", brandId] });
      qc.invalidateQueries({
        queryKey: ["catalog", "modifier-groups-with-options", brandId],
      });
      // Products that referenced this group lose the link — bust their cache too.
      qc.invalidateQueries({ queryKey: ["catalog", "products", brandId] });
    },
  });

  const filtered = useMemo(() => {
    if (!search.trim()) return groups;
    const q = search.toLowerCase();
    return groups.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        (g.plu ?? "").toLowerCase().includes(q),
    );
  }, [groups, search]);

  if (isLoading)
    return (
      <div className="space-y-2">
        {[1, 2].map((i) => (
          <div key={i} className="h-14 rounded-lg bg-zinc-100 animate-pulse" />
        ))}
      </div>
    );

  if (isCreating || editingId) {
    return (
      <ModifierGroupForm
        brandId={brandId}
        groupId={editingId ?? undefined}
        onCancel={() => {
          setIsCreating(false);
          setEditingId(null);
        }}
        onSaved={() => {
          setIsCreating(false);
          setEditingId(null);
          qc.invalidateQueries({ queryKey: ["catalog", "modifier-groups", brandId] });
          qc.invalidateQueries({
            queryKey: ["catalog", "modifier-groups-with-options", brandId],
          });
        }}
      />
    );
  }

  if (groups.length === 0)
    return (
      <CatalogEmptyState
        icon={ListTree}
        title="No modifier groups yet"
        description="A modifier group bundles related options together (e.g. 'Crusts', 'Toppings', 'Size'). Products attach modifier groups to expose those options at order time."
        ctaLabel="Create modifier group"
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
          Create modifier group
        </Button>
      </div>
      <div className="rounded-xl border border-zinc-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-zinc-500">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">Name</th>
              <th className="text-left font-medium px-4 py-2.5">PLU</th>
              <th className="text-left font-medium px-4 py-2.5">Type</th>
              <th className="text-center font-medium px-4 py-2.5">Modifiers</th>
              <th className="text-center font-medium px-4 py-2.5">Used by</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {filtered.map((g) => (
              <tr key={g.id} className="hover:bg-zinc-50">
                <td className="px-4 py-2.5 font-medium text-zinc-900">{g.name}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-zinc-600">
                  {g.plu ?? "—"}
                </td>
                <td className="px-4 py-2.5 text-xs text-zinc-600">
                  {g.selectionType === "VARIANT" ? "Pick one" : "Pick many"}
                  {g.minSelections > 0 && (
                    <span className="ml-1 text-zinc-400">· required</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-center tabular-nums">
                  {g.options?.length ?? 0}
                </td>
                <td className="px-4 py-2.5 text-center tabular-nums text-zinc-500">
                  {g._count?.itemLinks ?? 0} products
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="inline-flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingId(g.id)}
                      className="h-7 px-2 text-xs"
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const usedBy = g._count?.itemLinks ?? 0;
                        const warning =
                          usedBy > 0
                            ? `\n\nThis group is attached to ${usedBy} product${usedBy === 1 ? "" : "s"} — they will lose it.`
                            : "";
                        if (
                          confirm(
                            `Delete "${g.name}"?${warning}`,
                          )
                        ) {
                          deleteMutation.mutate(g.id);
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
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-zinc-400">
                  No groups match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
