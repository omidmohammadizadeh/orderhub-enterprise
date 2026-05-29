"use client";

import { useState, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Save, Trash2, Plus, X } from "lucide-react";
import {
  productsClient,
  modifierGroupsClient,
  type CatalogProduct,
} from "@/lib/api/catalog.client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ImageUploader } from "./image-uploader";
import { AttachModal } from "./attach-modal";

interface Props {
  brandId: string;
  productId?: string;
  onCancel: () => void;
  onSaved: () => void;
}

// A tiny prefix-cuid PLU helper. Matches Base44 style: PROD-{6 chars}.
const genPlu = () =>
  "PROD-" +
  Math.random().toString(36).slice(2, 8).toUpperCase();

// SKU PLU = parent PLU + index (Base44 convention). Falls back to a
// freshly generated PROD-XXXXXX-N when the parent PLU is empty.
const genSkuPlu = (parentPlu: string, index: number) => {
  const base = parentPlu.trim() || "PROD-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${base}-${index + 1}`;
};

export function ProductForm({ brandId, productId, onCancel, onSaved }: Props) {
  const qc = useQueryClient();
  const isEdit = !!productId;

  // ── Load existing product for edit mode ─────────────────────────────
  const { data: existing } = useQuery({
    queryKey: ["catalog", "product", productId],
    queryFn: () => productsClient.list(brandId).then((all) => all.find((p) => p.id === productId)),
    enabled: !!productId,
  });

  // ── Load modifier groups so we can attach ──────────────────────────
  const { data: allGroups = [] } = useQuery({
    queryKey: ["catalog", "modifier-groups", brandId],
    queryFn: () => modifierGroupsClient.list(brandId),
    enabled: !!brandId,
  });

  // ── Form state ──────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [plu, setPlu] = useState(genPlu());
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [basePrice, setBasePrice] = useState("0.00");
  const [deliveryTax, setDeliveryTax] = useState("0");
  const [takeawayTax, setTakeawayTax] = useState("0");
  const [eatInTax, setEatInTax] = useState("0");
  const [isAvailable, setIsAvailable] = useState(true);
  const [outOfStock, setOutOfStock] = useState(false);
  const [visibleToCustomers, setVisibleToCustomers] = useState(true);
  const [attachedGroupIds, setAttachedGroupIds] = useState<string[]>([]);
  // Multi-SKU state. When hasMultipleSkus is true, the per-SKU rows
  // below replace the base price + flat modifier groups. Each SKU has
  // its own name, PLU, price and attached modifier groups so a pizza
  // can carry 10"/12"/14" sizes each with size-specific toppings + crust
  // groups. Mirrors the Base44 productSkus[] shape.
  // Phase AL — explicit Add Existing modal state. Replaces the always-on
  // pill-grid picker; operator now sees only the attached items and
  // opens the modal by clicking "Add Existing".
  const [showAddGroupModal, setShowAddGroupModal] = useState(false);
  const [hasMultipleSkus, setHasMultipleSkus] = useState(false);
  const [skus, setSkus] = useState<
    Array<{
      name: string;
      plu: string;
      price: string;
      modifierGroupIds: string[];
    }>
  >([]);

  // Hydrate from server for edit mode.
  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setDescription(existing.description ?? "");
    setPlu(existing.plu ?? existing.sku ?? genPlu());
    setImageUrl(existing.imageUrl);
    setBasePrice(String(existing.basePrice));
    setDeliveryTax(String(existing.deliveryTax ?? 0));
    setTakeawayTax(String(existing.takeawayTax ?? 0));
    setEatInTax(String(existing.eatInTax ?? 0));
    setIsAvailable(existing.isAvailable);
    setOutOfStock(existing.outOfStock);
    setVisibleToCustomers(existing.visibleToCustomers);
    setAttachedGroupIds(
      (existing.modifierGroupLinks ?? []).map((l) => l.groupId),
    );
    setHasMultipleSkus(existing.hasMultipleSkus ?? false);
    setSkus(
      Array.isArray(existing.productSkus)
        ? existing.productSkus.map((s: any) => ({
            name: String(s.name ?? ""),
            plu: String(s.plu ?? ""),
            price: String(s.price ?? "0"),
            modifierGroupIds: Array.isArray(s.modifierGroups)
              ? s.modifierGroups
              : [],
          }))
        : [],
    );
  }, [existing]);

  const saveMutation = useMutation({
    mutationFn: async (): Promise<CatalogProduct> => {
      const cleanedSkus = skus
        .filter((s) => s.name.trim())
        .map((s) => ({
          name: s.name.trim(),
          plu: s.plu.trim(),
          price: Number(s.price) || 0,
          modifierGroups: s.modifierGroupIds,
        }));
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        plu: plu.trim() || null,
        imageUrl,
        basePrice: Number(basePrice) || 0,
        deliveryTax: Number(deliveryTax) || 0,
        takeawayTax: Number(takeawayTax) || 0,
        eatInTax: Number(eatInTax) || 0,
        isAvailable,
        outOfStock,
        visibleToCustomers,
        hasMultipleSkus: hasMultipleSkus && cleanedSkus.length > 0,
        productSkus: hasMultipleSkus ? cleanedSkus : [],
      };
      let saved: CatalogProduct;
      if (isEdit && productId) {
        saved = await productsClient.update(productId, payload);
      } else {
        saved = await productsClient.create(brandId, payload);
      }

      // Sync the attached modifier groups. We diff against the server's
      // current set (or empty for new products) so attach/detach calls
      // are minimal.
      const currentLinks =
        (existing?.modifierGroupLinks ?? []).map((l) => l.groupId) ?? [];
      const toAttach = attachedGroupIds.filter((id) => !currentLinks.includes(id));
      const toDetach = currentLinks.filter((id) => !attachedGroupIds.includes(id));
      for (const id of toAttach) {
        await productsClient.attachModifierGroup(saved.id, id);
      }
      for (const id of toDetach) {
        await productsClient.detachModifierGroup(saved.id, id);
      }
      return saved;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["catalog", "products", brandId] });
      onSaved();
    },
  });

  // Image used to be required at the form level; operator wants the option
  // to save without one (placeholder shown in the catalog list instead).
  const canSave = name.trim().length > 0;
  const attachedGroups = useMemo(
    () => allGroups.filter((g) => attachedGroupIds.includes(g.id)),
    [allGroups, attachedGroupIds],
  );
  const availableGroups = useMemo(
    () => allGroups.filter((g) => !attachedGroupIds.includes(g.id)),
    [allGroups, attachedGroupIds],
  );

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to products
        </button>
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={!canSave || saveMutation.isPending}
          className="bg-orange-500 hover:bg-orange-600 text-white"
        >
          <Save className="h-3.5 w-3.5 mr-1.5" />
          {saveMutation.isPending
            ? "Saving…"
            : isEdit
              ? "Save changes"
              : "Create product"}
        </Button>
      </div>

      {saveMutation.error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {(saveMutation.error as any)?.message ??
            "Could not save. Try again."}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* ── Left column: basics + modifier groups ────────────────── */}
        <div className="lg:col-span-2 space-y-5">
          <Card className="p-5">
            <h3 className="text-sm font-semibold text-zinc-900 mb-4">
              Basic details
            </h3>
            <div className="space-y-4">
              <Field label="Name" required>
                <Input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Margherita Pizza"
                  className="h-9 text-sm"
                />
              </Field>
              <Field label="PLU" hint="Auto-generated. Edit if you have a custom code.">
                <Input
                  value={plu}
                  onChange={(e) => setPlu(e.target.value)}
                  placeholder="PROD-XXXXXX"
                  className="h-9 text-sm font-mono"
                />
              </Field>
              <Field label="Description">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder="Brief description shown to customers."
                  className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
                />
              </Field>
            </div>
          </Card>

          {/* Multi-SKU toggle banner. Tick to switch from a flat product
              (single price + flat modifier groups) into a sized product
              (per-SKU price, PLU, and modifier groups — same shape as
              Base44 productSkus[]). */}
          <Card
            className={`p-4 border-2 ${
              hasMultipleSkus
                ? "border-orange-300 bg-orange-50/40"
                : "border-zinc-200"
            }`}
          >
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={hasMultipleSkus}
                onChange={(e) => {
                  setHasMultipleSkus(e.target.checked);
                  // Seed one empty SKU row so the editor is usable
                  // immediately; user can add more or remove the seed.
                  // PLU is auto-generated using the parent product PLU
                  // + index (matches Base44's PIZZA-MARG-1 / -2 / -3).
                  if (e.target.checked && skus.length === 0) {
                    setSkus([
                      {
                        name: "",
                        plu: genSkuPlu(plu, 0),
                        price: "0.00",
                        modifierGroupIds: [],
                      },
                    ]);
                  }
                }}
                className="mt-1 h-4 w-4"
              />
              <div>
                <p className="text-sm font-semibold text-zinc-900">
                  This product has multiple SKUs
                </p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Different sizes / variants — each with its own price,
                  PLU and modifier groups (e.g. 10&quot; / 12&quot; / 14&quot; pizza).
                </p>
              </div>
            </label>
          </Card>

          {hasMultipleSkus ? (
            // ── Multi-SKU editor ───────────────────────────────────
            <Card className="p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900">
                    Product SKUs
                  </h3>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Each SKU can attach its own modifier groups.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setSkus([
                      ...skus,
                      {
                        name: "",
                        plu: genSkuPlu(plu, skus.length),
                        price: "0.00",
                        modifierGroupIds: [],
                      },
                    ])
                  }
                  className="h-8 text-xs"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add SKU
                </Button>
              </div>

              <div className="space-y-3">
                {skus.map((sku, i) => (
                  <SkuRow
                    key={i}
                    sku={sku}
                    allGroups={allGroups}
                    onChange={(next) =>
                      setSkus(skus.map((r, idx) => (idx === i ? next : r)))
                    }
                    onRemove={() =>
                      setSkus(skus.filter((_, idx) => idx !== i))
                    }
                  />
                ))}
                {skus.length === 0 && (
                  <p className="text-xs text-zinc-400 italic">
                    No SKUs yet. Click &quot;Add SKU&quot; to add one.
                  </p>
                )}
              </div>
            </Card>
          ) : (
            // ── Flat product modifier groups ───────────────────────
            <Card className="p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-zinc-900">
                  Modifier Groups
                </h3>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setShowAddGroupModal(true)}
                    className="h-8 text-xs"
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Add Existing
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      // Open the standalone Modifier Groups tab so the
                      // operator can create the group there and come
                      // back. We could embed an inline form, but the
                      // standalone tab carries the full editor (PLU,
                      // selection type, modifiers) that's too dense to
                      // squeeze into a product form.
                      const url = new URL(window.location.href);
                      url.searchParams.set("tab", "modifier-groups");
                      window.open(url, "_blank");
                    }}
                    className="h-8 text-xs bg-zinc-900 hover:bg-zinc-800 text-white"
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Create New
                  </Button>
                </div>
              </div>

              <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-1.5 space-y-1.5">
                {attachedGroups.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-zinc-400 italic">
                    No modifier groups attached. Click &quot;Add Existing&quot;
                    to pick from the catalog or &quot;Create New&quot; to
                    make one.
                  </p>
                ) : (
                  attachedGroups.map((g) => (
                    <div
                      key={g.id}
                      className="group flex items-center justify-between rounded bg-white border border-zinc-100 px-3 py-2 hover:border-zinc-300"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-zinc-900">
                          {g.name}{" "}
                          <span className="text-[11px] font-normal text-zinc-500">
                            ({g.options?.length ?? 0} modifier
                            {g.options?.length === 1 ? "" : "s"})
                          </span>
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setAttachedGroupIds(
                            attachedGroupIds.filter((id) => id !== g.id),
                          )
                        }
                        className="text-zinc-300 hover:text-red-600 transition-colors"
                        title="Remove from this product"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))
                )}
              </div>

              <AttachModal
                open={showAddGroupModal}
                title="Add Modifier Groups"
                rows={allGroups.map((g) => ({
                  id: g.id,
                  name: g.name,
                  subtitle: g.plu ?? "",
                  meta: `${g.options?.length ?? 0} modifier${g.options?.length === 1 ? "" : "s"}`,
                }))}
                initiallyAttachedIds={attachedGroupIds}
                onConfirm={(ids) => {
                  setAttachedGroupIds(ids);
                  setShowAddGroupModal(false);
                }}
                onCancel={() => setShowAddGroupModal(false)}
              />
            </Card>
          )}

        </div>

        {/* ── Right column: image, pricing, status ─────────────────── */}
        <div className="space-y-5">
          <Card className="p-5">
            <h3 className="text-sm font-semibold text-zinc-900 mb-3">
              Image{" "}
              <span className="text-xs font-normal text-zinc-400">
                (recommended)
              </span>
            </h3>
            <ImageUploader value={imageUrl} onChange={setImageUrl} />
          </Card>

          <Card className="p-5">
            <h3 className="text-sm font-semibold text-zinc-900 mb-4">Pricing</h3>
            <div className="space-y-4">
              <Field label="Base price (£)">
                <Input
                  type="number"
                  step="0.01"
                  value={basePrice}
                  onChange={(e) => setBasePrice(e.target.value)}
                  className="h-9 text-sm tabular-nums"
                />
              </Field>
              <div className="pt-2 border-t border-zinc-100">
                <p className="text-[11px] uppercase tracking-wider text-zinc-400 mb-2">
                  Taxes (%)
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="Delivery">
                    <Input
                      type="number"
                      step="0.01"
                      value={deliveryTax}
                      onChange={(e) => setDeliveryTax(e.target.value)}
                      className="h-9 text-sm tabular-nums"
                    />
                  </Field>
                  <Field label="Takeaway">
                    <Input
                      type="number"
                      step="0.01"
                      value={takeawayTax}
                      onChange={(e) => setTakeawayTax(e.target.value)}
                      className="h-9 text-sm tabular-nums"
                    />
                  </Field>
                  <Field label="Eat-in">
                    <Input
                      type="number"
                      step="0.01"
                      value={eatInTax}
                      onChange={(e) => setEatInTax(e.target.value)}
                      className="h-9 text-sm tabular-nums"
                    />
                  </Field>
                </div>
                <p className="mt-2 text-[10px] text-zinc-400">
                  Enter as percentage. 20 = 20%, 0 = no tax.
                </p>
              </div>
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="text-sm font-semibold text-zinc-900 mb-4">
              Availability
            </h3>
            <div className="space-y-2.5">
              <Toggle
                label="Available"
                hint="Hide from POS, KDS, and customer menu when off."
                checked={isAvailable}
                onChange={setIsAvailable}
              />
              <Toggle
                label="Out of stock"
                hint="Shows in POS with an overlay; hidden from customer menu."
                checked={outOfStock}
                onChange={setOutOfStock}
              />
              <Toggle
                label="Visible to customers"
                hint="Show on the customer storefront. POS staff still see it."
                checked={visibleToCustomers}
                onChange={setVisibleToCustomers}
              />
            </div>
          </Card>
        </div>
      </div>

      {isEdit && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={async () => {
              if (!productId) return;
              if (
                !confirm(
                  "Delete this product? It will be removed from every menu and category.",
                )
              )
                return;
              await productsClient.remove(productId);
              qc.invalidateQueries({
                queryKey: ["catalog", "products", brandId],
              });
              onCancel();
            }}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 hover:text-red-700"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete product
          </button>
        </div>
      )}
    </div>
  );
}

// ── SKU row ────────────────────────────────────────────────────────────────
// One row in the Product SKUs editor. Each row owns its own name, PLU,
// price, AND attached modifier groups — so the operator can attach
// "10\" toppings" to the 10\" SKU and "12\" toppings" to the 12\" SKU.
// Mirrors the Base44 layout from the user's reference screenshot:
//   [name input] [price input] [PLU input] [×]
//   N modifier group(s)  + Existing | (group tag) (group tag)
function SkuRow({
  sku,
  allGroups,
  onChange,
  onRemove,
}: {
  sku: {
    name: string;
    plu: string;
    price: string;
    modifierGroupIds: string[];
  };
  allGroups: import("@/lib/api/catalog.client").CatalogModifierGroup[];
  onChange: (next: {
    name: string;
    plu: string;
    price: string;
    modifierGroupIds: string[];
  }) => void;
  onRemove: () => void;
}) {
  const [pickingGroup, setPickingGroup] = useState(false);
  const attached = allGroups.filter((g) =>
    sku.modifierGroupIds.includes(g.id),
  );
  const available = allGroups.filter(
    (g) => !sku.modifierGroupIds.includes(g.id),
  );

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3">
      <div className="grid grid-cols-12 gap-2 items-start">
        <Input
          placeholder='Size (e.g. 10")'
          value={sku.name}
          onChange={(e) => onChange({ ...sku, name: e.target.value })}
          className="col-span-3 h-9 text-sm"
        />
        <Input
          type="number"
          step="0.01"
          placeholder="Price (£)"
          value={sku.price}
          onChange={(e) => onChange({ ...sku, price: e.target.value })}
          className="col-span-3 h-9 text-sm tabular-nums"
        />
        <Input
          placeholder="PLU"
          value={sku.plu}
          onChange={(e) => onChange({ ...sku, plu: e.target.value })}
          className="col-span-5 h-9 text-sm font-mono"
        />
        <button
          type="button"
          onClick={onRemove}
          className="col-span-1 mt-2 text-red-400 hover:text-red-600"
          title="Remove SKU"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 pt-3 border-t border-zinc-100">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] uppercase tracking-wider text-zinc-400">
            {attached.length} modifier group{attached.length === 1 ? "" : "s"}
          </p>
          <button
            type="button"
            onClick={() => setPickingGroup(!pickingGroup)}
            disabled={available.length === 0}
            className="inline-flex items-center gap-1 rounded border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:border-orange-300 hover:bg-orange-50 disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
            {pickingGroup ? "Done" : "Attach group"}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {attached.map((g) => (
            <span
              key={g.id}
              className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-800"
            >
              {g.name}
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...sku,
                    modifierGroupIds: sku.modifierGroupIds.filter(
                      (id) => id !== g.id,
                    ),
                  })
                }
                className="text-orange-600 hover:text-orange-900"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          {attached.length === 0 && (
            <span className="text-[11px] italic text-zinc-400">
              No groups attached to this SKU yet.
            </span>
          )}
        </div>
        {pickingGroup && available.length > 0 && (
          <div className="mt-2 pt-2 border-t border-zinc-100">
            <p className="text-[10px] uppercase tracking-wider text-zinc-400 mb-1.5">
              Pick a group to attach
            </p>
            <div className="flex flex-wrap gap-1">
              {available.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => {
                    onChange({
                      ...sku,
                      modifierGroupIds: [...sku.modifierGroupIds, g.id],
                    });
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:border-orange-300 hover:bg-orange-50"
                >
                  <Plus className="h-2.5 w-2.5" />
                  {g.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-zinc-700">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </span>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-[11px] text-zinc-400">{hint}</p>}
    </label>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 text-left"
    >
      <span
        className={`mt-0.5 inline-flex h-5 w-9 rounded-full transition-colors flex-shrink-0 ${
          checked ? "bg-orange-500" : "bg-zinc-200"
        }`}
      >
        <span
          className={`m-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-zinc-900">{label}</span>
        {hint && <span className="block text-[11px] text-zinc-500">{hint}</span>}
      </span>
    </button>
  );
}
