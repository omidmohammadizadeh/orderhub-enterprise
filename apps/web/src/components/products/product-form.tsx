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
  }, [existing]);

  const saveMutation = useMutation({
    mutationFn: async (): Promise<CatalogProduct> => {
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

  const canSave = name.trim().length > 0 && !!imageUrl;
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

          <Card className="p-5">
            <h3 className="text-sm font-semibold text-zinc-900 mb-1">
              Modifier groups
            </h3>
            <p className="text-xs text-zinc-500 mb-4">
              Attach existing modifier groups (sizes, toppings, sauces, etc.).
              Customers see them in this order on the modifier modal.
            </p>
            <div className="space-y-2">
              {attachedGroups.length === 0 && (
                <p className="text-sm text-zinc-400 italic">No groups attached.</p>
              )}
              {attachedGroups.map((g) => (
                <div
                  key={g.id}
                  className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium text-zinc-900">{g.name}</p>
                    <p className="text-[11px] text-zinc-500">
                      {g.selectionType === "VARIANT" ? "Pick one" : "Pick many"}
                      {g.minSelections > 0 && " · required"}
                      {" · "}
                      {g.options?.length ?? 0} options
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setAttachedGroupIds(
                        attachedGroupIds.filter((id) => id !== g.id),
                      )
                    }
                    className="text-zinc-400 hover:text-red-600"
                    title="Detach"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {availableGroups.length > 0 && (
                <div className="pt-2">
                  <p className="text-[11px] uppercase tracking-wider text-zinc-400 mb-2">
                    Available groups
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {availableGroups.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() =>
                          setAttachedGroupIds([...attachedGroupIds, g.id])
                        }
                        className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 hover:border-orange-300 hover:bg-orange-50"
                      >
                        <Plus className="h-3 w-3" />
                        {g.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {allGroups.length === 0 && (
                <p className="text-xs text-zinc-400 mt-1">
                  No modifier groups yet — create some in the Modifier Groups
                  tab first.
                </p>
              )}
            </div>
          </Card>
        </div>

        {/* ── Right column: image, pricing, status ─────────────────── */}
        <div className="space-y-5">
          <Card className="p-5">
            <h3 className="text-sm font-semibold text-zinc-900 mb-3">
              Image <span className="text-red-500">*</span>
            </h3>
            <ImageUploader
              value={imageUrl}
              onChange={setImageUrl}
              required
            />
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
