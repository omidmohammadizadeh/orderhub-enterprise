"use client";

import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Save, Trash2, Plus, X } from "lucide-react";
import {
  modifiersClient,
  type CatalogModifier,
  type CatalogModifierGroup,
} from "@/lib/api/catalog.client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ImageUploader } from "./image-uploader";

interface Props {
  brandId: string;
  groups: CatalogModifierGroup[];
  modifierId?: string;
  onCancel: () => void;
  onSaved: () => void;
}

const genPlu = () =>
  "MOD-" + Math.random().toString(36).slice(2, 8).toUpperCase();

export function ModifierForm({
  brandId,
  groups,
  modifierId,
  onCancel,
  onSaved,
}: Props) {
  const qc = useQueryClient();
  const isEdit = !!modifierId;

  // Find the existing modifier by flattening all options.
  const existing: CatalogModifier | undefined = modifierId
    ? groups.flatMap((g) => g.options ?? []).find((o) => o.id === modifierId)
    : undefined;

  const [groupId, setGroupId] = useState<string>(existing?.groupId ?? groups[0]?.id ?? "");
  const [name, setName] = useState("");
  const [plu, setPlu] = useState(genPlu());
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [price, setPrice] = useState("0.00");
  const [isAvailable, setIsAvailable] = useState(true);
  const [visibleToCustomers, setVisibleToCustomers] = useState(true);
  const [deliveryTax, setDeliveryTax] = useState("0");
  const [takeawayTax, setTakeawayTax] = useState("0");
  const [eatInTax, setEatInTax] = useState("0");
  // Per-size pricing and PLUs (Base44 prices_by_size + sku_plus). We keep
  // it as an array of {size, price, plu} rows for editor ergonomics and
  // collapse to the JSON shape on save.
  const [sizeRows, setSizeRows] = useState<
    Array<{ size: string; price: string; plu: string }>
  >([]);

  useEffect(() => {
    if (!existing) return;
    setGroupId(existing.groupId);
    setName(existing.name);
    setPlu(existing.plu ?? genPlu());
    setImageUrl(existing.imageUrl);
    setPrice(String(existing.priceAdjustment));
    setIsAvailable(existing.isAvailable);
    setVisibleToCustomers(existing.visibleToCustomers);
    setDeliveryTax(String(existing.deliveryTax ?? 0));
    setTakeawayTax(String(existing.takeawayTax ?? 0));
    setEatInTax(String(existing.eatInTax ?? 0));
    const sizes = new Set([
      ...Object.keys(existing.pricesBySize ?? {}),
      ...Object.keys(existing.skuPlus ?? {}),
    ]);
    setSizeRows(
      Array.from(sizes).map((s) => ({
        size: s,
        price: String((existing.pricesBySize as any)?.[s] ?? ""),
        plu: String((existing.skuPlus as any)?.[s] ?? ""),
      })),
    );
  }, [existing]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const pricesBySize: Record<string, number> = {};
      const skuPlus: Record<string, string> = {};
      for (const r of sizeRows) {
        if (!r.size.trim()) continue;
        if (r.price) pricesBySize[r.size] = Number(r.price);
        if (r.plu) skuPlus[r.size] = r.plu;
      }
      const payload = {
        name: name.trim(),
        plu: plu.trim() || null,
        imageUrl,
        priceAdjustment: Number(price) || 0,
        pricesBySize,
        skuPlus,
        isAvailable,
        visibleToCustomers,
        deliveryTax: Number(deliveryTax) || 0,
        takeawayTax: Number(takeawayTax) || 0,
        eatInTax: Number(eatInTax) || 0,
      };
      if (isEdit && modifierId) {
        return modifiersClient.update(modifierId, payload);
      }
      if (!groupId) throw new Error("Pick a group first");
      return modifiersClient.create(groupId, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["catalog", "modifier-groups-with-options", brandId],
      });
      onSaved();
    },
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to modifiers
        </button>
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={!name.trim() || !groupId || saveMutation.isPending}
          className="bg-orange-500 hover:bg-orange-600 text-white"
        >
          <Save className="h-3.5 w-3.5 mr-1.5" />
          {saveMutation.isPending ? "Saving…" : isEdit ? "Save" : "Create modifier"}
        </Button>
      </div>

      {/* Phase AP follow-up: the "which modifier group?" picker was
          removed at the operator's request. The modifier still needs a
          parent group (ModifierOption.groupId is NOT NULL on the
          schema), so we auto-bind to the first group on this location
          via the existing groups[0]?.id default and let the operator
          attach the modifier to additional groups later from the
          Modifier Group form.

          When there are zero groups we surface a one-line nudge to
          create one first instead of letting the operator start a
          form that's guaranteed to fail on save. */}
      {!isEdit && groups.length === 0 && (
        <Card className="p-3 border-amber-200 bg-amber-50 text-xs text-amber-800">
          You don&apos;t have any modifier groups yet at this location.
          Create one in the Modifier Groups tab first — modifiers always
          live inside a group.
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card className="p-5 lg:col-span-2 space-y-4">
          <h3 className="text-sm font-semibold text-zinc-900">Basic details</h3>
          <label className="block">
            <span className="text-xs font-medium text-zinc-700">
              Name <span className="text-red-500">*</span>
            </span>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Extra Cheese, Mushrooms"
              className="mt-1 h-9 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-zinc-700">PLU</span>
            <Input
              value={plu}
              onChange={(e) => setPlu(e.target.value)}
              className="mt-1 h-9 text-sm font-mono"
            />
          </label>

          <div className="pt-3 border-t border-zinc-100">
            <h4 className="text-xs font-semibold text-zinc-800 mb-1">
              Per-size pricing
            </h4>
            <p className="text-[11px] text-zinc-500 mb-3">
              For pizza-style products: charge a different price (and use a
              different PLU) per size. Leave empty if the base price is the
              only one.
            </p>
            <div className="space-y-1.5">
              {sizeRows.map((row, i) => (
                <div key={i} className="flex gap-1.5">
                  <Input
                    placeholder="Size key (e.g. 10)"
                    value={row.size}
                    onChange={(e) =>
                      setSizeRows(
                        sizeRows.map((r, idx) =>
                          idx === i ? { ...r, size: e.target.value } : r,
                        ),
                      )
                    }
                    className="w-28 h-8 text-xs"
                  />
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="£0.00"
                    value={row.price}
                    onChange={(e) =>
                      setSizeRows(
                        sizeRows.map((r, idx) =>
                          idx === i ? { ...r, price: e.target.value } : r,
                        ),
                      )
                    }
                    className="w-24 h-8 text-xs tabular-nums"
                  />
                  <Input
                    placeholder="SKU/PLU"
                    value={row.plu}
                    onChange={(e) =>
                      setSizeRows(
                        sizeRows.map((r, idx) =>
                          idx === i ? { ...r, plu: e.target.value } : r,
                        ),
                      )
                    }
                    className="flex-1 h-8 text-xs font-mono"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setSizeRows(sizeRows.filter((_, idx) => idx !== i))
                    }
                    className="text-zinc-400 hover:text-red-600 px-2"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setSizeRows([...sizeRows, { size: "", price: "", plu: "" }])
                }
                className="h-8 text-xs"
              >
                <Plus className="h-3 w-3 mr-1" />
                Add size row
              </Button>
            </div>
          </div>
        </Card>

        <div className="space-y-5">
          <Card className="p-5">
            <h3 className="text-sm font-semibold text-zinc-900 mb-3">
              Image <span className="text-zinc-400 font-normal">(optional)</span>
            </h3>
            <ImageUploader value={imageUrl} onChange={setImageUrl} />
          </Card>

          <Card className="p-5 space-y-4">
            <h3 className="text-sm font-semibold text-zinc-900">Pricing</h3>
            <label className="block">
              <span className="text-xs font-medium text-zinc-700">
                Base price (£)
              </span>
              <Input
                type="number"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="mt-1 h-9 text-sm tabular-nums"
              />
            </label>
            <div className="pt-2 border-t border-zinc-100">
              <p className="text-[11px] uppercase tracking-wider text-zinc-400 mb-2">
                Taxes (%)
              </p>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Delivery", value: deliveryTax, set: setDeliveryTax },
                  { label: "Takeaway", value: takeawayTax, set: setTakeawayTax },
                  { label: "Eat-in", value: eatInTax, set: setEatInTax },
                ].map((f) => (
                  <label key={f.label} className="block">
                    <span className="text-[11px] text-zinc-500">{f.label}</span>
                    <Input
                      type="number"
                      step="0.01"
                      value={f.value}
                      onChange={(e) => f.set(e.target.value)}
                      className="mt-0.5 h-8 text-xs tabular-nums"
                    />
                  </label>
                ))}
              </div>
            </div>
            <div className="pt-2 border-t border-zinc-100 space-y-1.5">
              <label className="flex items-center gap-2 text-xs text-zinc-700">
                <input
                  type="checkbox"
                  checked={isAvailable}
                  onChange={(e) => setIsAvailable(e.target.checked)}
                />
                Available
              </label>
              <label className="flex items-center gap-2 text-xs text-zinc-700">
                <input
                  type="checkbox"
                  checked={visibleToCustomers}
                  onChange={(e) => setVisibleToCustomers(e.target.checked)}
                />
                Visible to customers
              </label>
            </div>
          </Card>
        </div>
      </div>

      {isEdit && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={async () => {
              if (!modifierId) return;
              if (!confirm("Delete this modifier?")) return;
              await modifiersClient.remove(modifierId);
              qc.invalidateQueries({
                queryKey: ["catalog", "modifier-groups-with-options", brandId],
              });
              onCancel();
            }}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 hover:text-red-700"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete modifier
          </button>
        </div>
      )}
    </div>
  );
}
