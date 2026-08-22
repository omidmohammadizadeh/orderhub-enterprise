"use client";

// Phase AL — minimal Variants editor. Lets the operator see and edit
// the productSkus[] JSON on a multi-SKU product, plus the per-platform
// pricing overrides. Full pizza-style ergonomics (attach modifier
// groups per SKU via a picker) come in a follow-up; for now SKU.modifierGroups
// is editable as a comma-separated list of group IDs.

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Save, Plus, X } from "lucide-react";
import { productsClient } from "@/lib/api/catalog.client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";

interface Props {
  productId: string;
  onClose: () => void;
}

const PLATFORM_FIELDS = [
  { key: "POS", label: "POS" },
  { key: "ONLINE", label: "Online ordering" },
  { key: "UBER_EATS", label: "Uber Eats" },
  { key: "DELIVEROO", label: "Deliveroo" },
  { key: "JUST_EAT", label: "Just Eat" },
] as const;

interface SkuRow {
  name: string;
  plu: string;
  price: string;
  modifierGroups: string[];
}

export function VariantsEditor({ productId, onClose }: Props) {
  const qc = useQueryClient();

  const { data: product } = useQuery({
    queryKey: ["catalog", "product", productId],
    queryFn: async () => {
      const all = await productsClient.list(""); // brand list — will fail without brand
      return all.find((p) => p.id === productId);
    },
    enabled: false, // we hydrate below via products list
  });

  const [skus, setSkus] = useState<SkuRow[]>([]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  // Hydrate from the product cache that the parent tab already loaded.
  useEffect(() => {
    const cached = qc
      .getQueryData<any[]>(["catalog", "products"])
      ?.find((p) => p.id === productId);
    const p =
      cached ??
      qc
        .getQueriesData<any[]>({ queryKey: ["catalog", "products"] })
        .flatMap(([, data]) => (Array.isArray(data) ? data : []))
        .find((p) => p?.id === productId);
    if (!p) return;
    const rawSkus = Array.isArray(p.productSkus) ? p.productSkus : [];
    setSkus(
      rawSkus.map((s: any) => ({
        name: String(s.name ?? ""),
        plu: String(s.plu ?? ""),
        price: String(s.price ?? "0"),
        modifierGroups: Array.isArray(s.modifierGroups) ? s.modifierGroups : [],
      })),
    );
    const op = (p.platformPricingOverrides ?? {}) as Record<string, number>;
    const next: Record<string, string> = {};
    for (const f of PLATFORM_FIELDS) {
      if (op[f.key] != null) next[f.key] = String(op[f.key]);
    }
    setOverrides(next);
  }, [productId, qc]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const cleaned = skus
        .filter((s) => s.name.trim())
        .map((s) => ({
          name: s.name.trim(),
          plu: s.plu.trim(),
          price: Number(s.price) || 0,
          modifierGroups: s.modifierGroups,
        }));
      const ovrPayload: Record<string, number> = {};
      for (const [k, v] of Object.entries(overrides)) {
        if (v && !Number.isNaN(Number(v))) ovrPayload[k] = Number(v);
      }
      return productsClient.update(productId, {
        hasMultipleSkus: cleaned.length > 0,
        productSkus: cleaned,
        platformPricingOverrides: ovrPayload,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["catalog", "products"] });
      onClose();
    },
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={onClose}
          className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to variants
        </button>
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          className="bg-orange-500 hover:bg-orange-600 text-white"
        >
          <Save className="h-3.5 w-3.5 mr-1.5" />
          {saveMutation.isPending ? "Saving…" : "Save variants"}
        </Button>
      </div>

      <Card className="p-5">
        <h3 className="text-sm font-semibold text-zinc-900 mb-1">SKUs</h3>
        <p className="text-[11px] text-zinc-500 mb-3">
          Each SKU has its own name, PLU and price. Attach different modifier
          groups per SKU (comma-separated group IDs for now — picker UI lands
          next).
        </p>
        <div className="space-y-2">
          {skus.map((s, i) => (
            <div
              key={i}
              className="rounded-md border border-zinc-200 p-3 grid grid-cols-12 gap-2 items-start"
            >
              <Input
                placeholder="Name (e.g. 10 inch)"
                value={s.name}
                onChange={(e) =>
                  setSkus(
                    skus.map((row, idx) =>
                      idx === i ? { ...row, name: e.target.value } : row,
                    ),
                  )
                }
                className="col-span-3 h-9 text-sm"
              />
              <Input
                placeholder="PLU"
                value={s.plu}
                onChange={(e) =>
                  setSkus(
                    skus.map((row, idx) =>
                      idx === i ? { ...row, plu: e.target.value } : row,
                    ),
                  )
                }
                className="col-span-3 h-9 text-sm font-mono"
              />
              <Input
                type="number"
                step="0.01"
                placeholder="Price ({symbol.trim()})"
                value={s.price}
                onChange={(e) =>
                  setSkus(
                    skus.map((row, idx) =>
                      idx === i ? { ...row, price: e.target.value } : row,
                    ),
                  )
                }
                className="col-span-2 h-9 text-sm tabular-nums"
              />
              <Input
                placeholder="Modifier group IDs (comma-separated)"
                value={s.modifierGroups.join(",")}
                onChange={(e) =>
                  setSkus(
                    skus.map((row, idx) =>
                      idx === i
                        ? {
                            ...row,
                            modifierGroups: e.target.value
                              .split(",")
                              .map((x) => x.trim())
                              .filter(Boolean),
                          }
                        : row,
                    ),
                  )
                }
                className="col-span-3 h-9 text-xs font-mono"
              />
              <button
                type="button"
                onClick={() => setSkus(skus.filter((_, idx) => idx !== i))}
                className="col-span-1 text-zinc-400 hover:text-red-600 mt-2"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setSkus([
                ...skus,
                { name: "", plu: "", price: "0.00", modifierGroups: [] },
              ])
            }
            className="h-8 text-xs"
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add SKU
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="text-sm font-semibold text-zinc-900 mb-1">
          Platform-specific pricing
        </h3>
        <p className="text-[11px] text-zinc-500 mb-3">
          Override the base price per channel. Empty fields fall through to
          the base product price (or the per-SKU price for multi-SKU items).
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {PLATFORM_FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className="text-xs font-medium text-zinc-700">{f.label}</span>
              <Input
                type="number"
                step="0.01"
                value={overrides[f.key] ?? ""}
                onChange={(e) =>
                  setOverrides({ ...overrides, [f.key]: e.target.value })
                }
                placeholder="No override"
                className="mt-1 h-9 text-sm tabular-nums"
              />
            </label>
          ))}
        </div>
      </Card>
    </div>
  );
}
