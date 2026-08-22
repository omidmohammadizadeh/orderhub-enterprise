"use client";

import { useState, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { capitaliseFirst } from "@orderhub/shared";

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

  // Phase AW-18.4 — single-row read. The earlier list-then-find
  // through `groups` returned undefined when the modifier's owning
  // group lived under a different brand than the form's `brandId`
  // (HubRise-imported groups, repeat of the AW-12 family). Hitting
  // GET /v1/modifier-options/:id makes hydration brand-drift safe.
  const { data: fetched } = useQuery({
    queryKey: ["catalog", "modifier-option", modifierId],
    queryFn: () => modifiersClient.get(modifierId!),
    enabled: !!modifierId,
  });
  const existing: CatalogModifier | undefined =
    fetched ??
    (modifierId
      ? groups.flatMap((g) => g.options ?? []).find((o) => o.id === modifierId)
      : undefined);

  const [groupId, setGroupId] = useState<string>(existing?.groupId ?? groups[0]?.id ?? "");
  const [name, setName] = useState("");
  // Kitchen-language name. Filled by Translate, but ALWAYS editable — a
  // machine translation that reads wrong to the chef has to be correctable by
  // the person who spotted it, not by re-running the whole menu.
  const [secondLanguageName, setSecondLanguageName] = useState("");
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
  // Phase BN — groups this option opens when chosen, in ask order.
  const [nestedGroupIds, setNestedGroupIds] = useState<string[]>([]);
  // Names come from the option itself. The brand-scoped `groups` list is only
  // a fallback for a group the operator just added in this session.
  const nestedNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) m.set(g.id, g.name);
    for (const n of existing?.nestedGroups ?? []) {
      if (n.name) m.set(n.id, n.name);
    }
    return m;
  }, [groups, existing]);

  useEffect(() => {
    if (!existing) return;
    setGroupId(existing.groupId);
    setName(existing.name);
    setSecondLanguageName((existing as any).secondLanguageName ?? "");
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
    setNestedGroupIds((existing as any).nestedGroupIds ?? []);
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
        name: capitaliseFirst(name),
        // null, not "", so clearing the box removes the translation rather
        // than storing a blank that reads as "translated to nothing".
        secondLanguageName: secondLanguageName.trim() || null,
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
        // Sent on every save, including empty — that's how the last
        // follow-on group gets removed.
        nestedGroupIds,
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
            <span className="text-xs font-medium text-zinc-600">
              Kitchen name
              <span className="ml-1 font-normal text-zinc-400">
                — printed on the kitchen ticket instead of the name above
              </span>
            </span>
            <Input
              value={secondLanguageName}
              onChange={(e) => setSecondLanguageName(e.target.value)}
              placeholder="Leave blank to print the name above"
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

          {/* Phase BN — the groups this option opens when it's chosen.
              "Make It a Meal +£3.99" asks for a side and a drink; picking
              "Fries" in that side group then asks for a dip. Without this
              section an imported meal deal was indistinguishable in the
              editor from a plain £3.99 option. */}
          <div className="pt-3 border-t border-zinc-100">
            <h4 className="text-xs font-semibold text-zinc-800 mb-1">
              Follow-on choices
            </h4>
            <p className="text-[11px] text-zinc-500 mb-3">
              Groups to ask for when someone picks this modifier — a meal
              upgrade asking for a side and a drink. They&apos;re asked in the
              order below, and only once this modifier is selected.
            </p>

            {nestedGroupIds.length === 0 ? (
              <p className="text-[11px] text-zinc-400 mb-2">
                None — picking this modifier asks nothing further.
              </p>
            ) : (
              <div className="space-y-1.5 mb-2">
                {nestedGroupIds.map((id, i) => {
                  const groupName = nestedNameById.get(id);
                  const optionCount = groups.find((g) => g.id === id)?.options
                    ?.length;
                  return (
                    <div
                      key={id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 px-3 py-2"
                    >
                      <span className="text-xs text-zinc-900">
                        <span className="text-zinc-400 tabular-nums mr-2">
                          {i + 1}.
                        </span>
                        {groupName || "Unknown group"}
                        {optionCount !== undefined && (
                          <span className="text-zinc-400 ml-1.5">
                            ({optionCount} modifier
                            {optionCount === 1 ? "" : "s"})
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setNestedGroupIds(
                            nestedGroupIds.filter((x) => x !== id),
                          )
                        }
                        className="text-zinc-400 hover:text-red-600"
                        title="Remove"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Dashed and muted so it reads as an action, not as another
                follow-on group. Flush against the rows above it, an empty
                select looked like a third entry with no name. */}
            <select
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                setNestedGroupIds([...nestedGroupIds, e.target.value]);
              }}
              className="mt-2 w-full h-8 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-2 text-xs text-zinc-500"
            >
              <option value="">Add a follow-on group…</option>
              {groups
                // A group can't open itself — that's a picker that reopens
                // forever — and adding the same one twice asks it twice.
                .filter(
                  (g) =>
                    g.id !== existing?.groupId && !nestedGroupIds.includes(g.id),
                )
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </select>
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
