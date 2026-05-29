"use client";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Sparkles } from "lucide-react";
import { upsellGroupsClient } from "@/lib/api/catalog.client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { CatalogEmptyState } from "./empty-state";

interface Props {
  brandId: string;
  search: string;
}

// Phase AL — basic UI on the new UpsellGroup model. Full trigger/suggest
// picker lands in a follow-up; this scaffold lets operators create groups
// so we can wire storefront + POS surface logic against real records.
export function UpsellGroupsTab({ brandId, search }: Props) {
  const qc = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");

  const { data: groups = [], isLoading } = useQuery({
    queryKey: ["catalog", "upsell-groups", brandId],
    queryFn: () => upsellGroupsClient.list(brandId),
    enabled: !!brandId,
  });

  const filtered = useMemo(
    () =>
      groups.filter((g) =>
        search.trim()
          ? g.name.toLowerCase().includes(search.toLowerCase())
          : true,
      ),
    [groups, search],
  );

  const createMutation = useMutation({
    mutationFn: () => upsellGroupsClient.create(brandId, { name: name.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["catalog", "upsell-groups", brandId] });
      setIsCreating(false);
      setName("");
    },
  });

  if (isLoading)
    return (
      <div className="space-y-2">
        {[1, 2].map((i) => (
          <div key={i} className="h-14 rounded-lg bg-zinc-100 animate-pulse" />
        ))}
      </div>
    );

  if (groups.length === 0 && !isCreating)
    return (
      <CatalogEmptyState
        icon={Sparkles}
        title="No upsell groups yet"
        description="Upsell groups surface 'you might also like' suggestions when triggers fire (e.g. show desserts when a main is in the cart). Foundation only for now — full picker lands in the next iteration."
        ctaLabel="Create upsell group"
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
          Create upsell group
        </Button>
      </div>

      {isCreating && (
        <Card className="p-4 border-orange-200 bg-orange-50">
          <p className="text-sm font-medium text-zinc-800 mb-3">
            New upsell group
          </p>
          <div className="flex gap-2">
            <Input
              autoFocus
              placeholder="e.g. Desserts with mains"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 h-9 text-sm"
            />
            <Button
              size="sm"
              onClick={() => createMutation.mutate()}
              disabled={!name.trim() || createMutation.isPending}
              className="bg-orange-500 hover:bg-orange-600 text-white"
            >
              Create
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setIsCreating(false);
                setName("");
              }}
            >
              Cancel
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">
            Triggers (products / categories), suggestions, and platform
            visibility flags come in a follow-up.
          </p>
        </Card>
      )}

      <div className="rounded-xl border border-zinc-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-zinc-500">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">Name</th>
              <th className="text-center font-medium px-4 py-2.5">Triggers</th>
              <th className="text-center font-medium px-4 py-2.5">Suggestions</th>
              <th className="text-center font-medium px-4 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {filtered.map((g) => (
              <tr key={g.id} className="hover:bg-zinc-50">
                <td className="px-4 py-2.5 font-medium text-zinc-900">{g.name}</td>
                <td className="px-4 py-2.5 text-center tabular-nums text-zinc-500">
                  {g.triggerProductIds.length + g.triggerCategoryIds.length}
                </td>
                <td className="px-4 py-2.5 text-center tabular-nums text-zinc-500">
                  {g.suggestedProductIds.length}
                </td>
                <td className="px-4 py-2.5 text-center">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      g.isActive ? "bg-emerald-500" : "bg-zinc-300"
                    }`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
