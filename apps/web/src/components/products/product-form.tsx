"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useCurrency } from "@/hooks/use-currency";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { locationsClient } from "@/lib/api/locations.client";
import { ArrowLeft, Save, Trash2, Plus, X, Layers, GripVertical } from "lucide-react";
import toast from "react-hot-toast";
import {
  productsClient,
  modifierGroupsClient,
  type CatalogProduct,
} from "@/lib/api/catalog.client";
import { brandsClient } from "@/lib/api/menus.client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ImageUploader } from "./image-uploader";
import { AttachModal } from "./attach-modal";
import { ApplyToItemsModal } from "./apply-to-items-modal";
import { ModifierGroupForm } from "./modifier-group-form";
import { capitaliseFirst } from "@orderhub/shared";

interface Props {
  brandId: string;
  /** Phase AP — stamp new products with this location so they show
   *  up in the location-scoped Products tab. */
  locationId?: string;
  productId?: string;
  /** The menu being edited, when opened from the menu editor. Enables the
   *  "Apply to other items" actions — they list items from THIS menu only,
   *  so they're meaningless without it. */
  menuId?: string;
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

export function ProductForm({
  brandId,
  locationId,
  productId,
  menuId,
  onCancel,
  onSaved,
}: Props) {
  // Prices follow the selected location's currency, not a hardcoded pound.
  const { money, symbol } = useCurrency();
  const qc = useQueryClient();
  const isEdit = !!productId;

  // Kitchen translations are per-location and off by default: most shops print
  // English and should never see a second name box on every product.
  const kitchenLangQuery = useQuery({
    queryKey: ["location", locationId],
    queryFn: () => locationsClient.get(locationId!),
    enabled: !!locationId,
    staleTime: 5 * 60_000,
  });
  const kitchenLanguageOn =
    ((kitchenLangQuery.data as any)?.settings ?? {}).kitchenTicketSecondLanguage === true;

  // ── Load existing product for edit mode ─────────────────────────────
  // Phase AW-12 — direct by-id lookup. The previous list-then-find
  // pattern silently dropped products whose brandId didn't match the
  // brand the editor was loaded with (HubRise re-imports, publish
  // picker reassignment, etc), leaving the form empty.
  const { data: existing } = useQuery({
    queryKey: ["catalog", "product", productId],
    queryFn: () => productsClient.get(productId!),
    enabled: !!productId,
  });

  // Which location's catalogue this form is working in.
  //
  // The Products tab hands us a locationId directly. The menu editor only
  // has one when the menu itself is location-stamped — so for a brand-level
  // menu we fall back to the location the product being edited lives at,
  // which is the site whose modifier groups the operator actually wants.
  const scopeLocationId =
    locationId ?? ((existing as any)?.locationId as string | undefined);

  // ── Load modifier groups so we can attach ──────────────────────────
  //
  // Location-scoped whenever we know the location. A multi-site tenant
  // builds one "Please select your extra toppings" group PER site, so the
  // brand-wide list showed eight identical names distinguishable only by
  // PLU and the operator had no way to pick their own. Mirrors how the
  // Products and Modifier Groups tabs already load.
  const { data: allGroups = [] } = useQuery({
    queryKey: ["catalog", "modifier-groups", scopeLocationId ?? brandId],
    queryFn: () =>
      scopeLocationId
        ? modifierGroupsClient.listForLocation(scopeLocationId)
        : modifierGroupsClient.list(brandId),
    enabled: !!brandId || !!scopeLocationId,
  });

  // ── Load brands for the per-product brand tagging (Phase AZ) ────────
  const { data: brands = [] } = useQuery({
    queryKey: ["brands"],
    queryFn: () => brandsClient.list(),
  });

  // ── Form state ──────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [plu, setPlu] = useState(genPlu());
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [basePrice, setBasePrice] = useState("0.00");
  // Kitchen-language name. Customers always see `name`; the kitchen ticket
  // prints this when the location has translations switched on.
  const [secondLanguageName, setSecondLanguageName] = useState("");
  const [deliveryTax, setDeliveryTax] = useState("0");
  const [takeawayTax, setTakeawayTax] = useState("0");
  const [eatInTax, setEatInTax] = useState("0");
  const [isAvailable, setIsAvailable] = useState(true);
  const [outOfStock, setOutOfStock] = useState(false);
  const [visibleToCustomers, setVisibleToCustomers] = useState(true);
  // Which service modes this product is sold in. All three on by default —
  // unticking one is the exception, not the setup step.
  const [availableCollection, setAvailableCollection] = useState(true);
  const [availableDelivery, setAvailableDelivery] = useState(true);
  const [availableDineIn, setAvailableDineIn] = useState(true);
  const [attachedGroupIds, setAttachedGroupIds] = useState<string[]>([]);
  // Which row is being dragged. A ref, not state: it changes during a drag
  // and re-rendering on every dragover would fight the browser's own drag.
  const draggingGroupIdx = useRef<number | null>(null);
  // Multi-SKU state. When hasMultipleSkus is true, the per-SKU rows
  // below replace the base price + flat modifier groups. Each SKU has
  // its own name, PLU, price and attached modifier groups so a pizza
  // can carry 10"/12"/14" sizes each with size-specific toppings + crust
  // groups. Mirrors the Base44 productSkus[] shape.
  // Phase AL — explicit Add Existing modal state. Replaces the always-on
  // pill-grid picker; operator now sees only the attached items and
  // opens the modal by clicking "Add Existing".
  const [showAddGroupModal, setShowAddGroupModal] = useState(false);
  // "Create New" modifier group inline modal. Renders the full
  // ModifierGroupForm in an overlay so the operator never leaves
  // the product page. On save, the new group's id is appended to
  // attachedGroupIds so it auto-attaches to this product.
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  // Phase AW-18.2 — click an attached group row to open it for edit.
  // Reuses the same ModifierGroupForm shell as Create New, just with
  // groupId set so the form hydrates from the server.
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  // Per-SKU modifier modals: which SKU index the Add-Existing / Create-New
  // dialog is currently targeting (multi-SKU products attach groups per size).
  const [skuAttachTarget, setSkuAttachTarget] = useState<number | null>(null);
  // "Apply to other items". Null = closed; otherwise what we're spreading.
  // Groups are linked, sizes are copied — see ApplyToItemsModal.
  const [applyMode, setApplyMode] = useState<"groups" | "skus" | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [skuCreateTarget, setSkuCreateTarget] = useState<number | null>(null);
  const [hasMultipleSkus, setHasMultipleSkus] = useState(false);
  const [skus, setSkus] = useState<
    Array<{
      name: string;
      plu: string;
      price: string;
      modifierGroupIds: string[];
      // Preserved opaquely so editing the product here doesn't wipe the
      // per-channel size prices set in the Channel-pricing matrix.
      priceOverrides?: Record<string, number>;
    }>
  >([]);
  // Phase AZ — which brands this product belongs to. New products default
  // to the brand the form is scoped to; the publisher uses this to restrict
  // the product to its brand's HubRise variants.
  const [brandIds, setBrandIds] = useState<string[]>(
    productId ? [] : brandId ? [brandId] : [],
  );

  // Hydrate from server for edit mode.
  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setDescription(existing.description ?? "");
    setPlu(existing.plu ?? existing.sku ?? genPlu());
    setImageUrl(existing.imageUrl);
    setBasePrice(String(existing.basePrice));
    setSecondLanguageName((existing as any).secondLanguageName ?? "");
    setDeliveryTax(String(existing.deliveryTax ?? 0));
    setTakeawayTax(String(existing.takeawayTax ?? 0));
    setEatInTax(String(existing.eatInTax ?? 0));
    setIsAvailable(existing.isAvailable);
    setOutOfStock(existing.outOfStock);
    setVisibleToCustomers(existing.visibleToCustomers);
    // `!== false` rather than `?? true`: products saved before this existed
    // have the field absent, and they are sold everywhere.
    setAvailableCollection((existing as any).availableCollection !== false);
    setAvailableDelivery((existing as any).availableDelivery !== false);
    setAvailableDineIn((existing as any).availableDineIn !== false);
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
            ...(s.priceOverrides ? { priceOverrides: s.priceOverrides } : {}),
          }))
        : [],
    );
    setBrandIds(
      Array.isArray((existing as any).brandIds) && (existing as any).brandIds.length
        ? (existing as any).brandIds
        : existing.brandId
          ? [existing.brandId]
          : [],
    );
  }, [existing]);

  const saveMutation = useMutation({
    mutationFn: async (): Promise<CatalogProduct> => {
      const cleanedSkus = skus
        .filter((s) => s.name.trim())
        .map((s) => ({
          name: capitaliseFirst(s.name),
          plu: s.plu.trim(),
          price: Number(s.price) || 0,
          modifierGroups: s.modifierGroupIds,
          // Keep any per-channel size prices set in the Channel-pricing matrix.
          ...(s.priceOverrides ? { priceOverrides: s.priceOverrides } : {}),
        }));
      const payload = {
        name: capitaliseFirst(name),
        description: description.trim() || null,
        plu: plu.trim() || null,
        imageUrl,
        basePrice: Number(basePrice) || 0,
        // null, not "", so an emptied box clears the translation rather than
        // storing a blank that reads as "translated to nothing".
        secondLanguageName: secondLanguageName.trim() || null,
        deliveryTax: Number(deliveryTax) || 0,
        takeawayTax: Number(takeawayTax) || 0,
        eatInTax: Number(eatInTax) || 0,
        isAvailable,
        outOfStock,
        visibleToCustomers,
        availableCollection,
        availableDelivery,
        availableDineIn,
        brandIds,
        hasMultipleSkus: hasMultipleSkus && cleanedSkus.length > 0,
        productSkus: hasMultipleSkus ? cleanedSkus : [],
      };
      let saved: CatalogProduct;
      if (isEdit && productId) {
        saved = await productsClient.update(productId, payload);
      } else {
        // Phase AP — pass locationId so the new product lands in this
        // location's Products tab right away.
        saved = await productsClient.create(brandId, {
          ...payload,
          ...(locationId && { locationId }),
        });
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
      // Persist the ORDER. Attaching alone leaves every link at sortOrder 0,
      // so without this the picker asks for crust, base and toppings in
      // whatever order the rows come back in.
      if (attachedGroupIds.length > 1) {
        await productsClient
          .reorderModifierGroups(saved.id, attachedGroupIds)
          // Order is cosmetic next to the save itself — never fail a saved
          // product because the sequence did not stick.
          .catch(() => undefined);
      }
      return saved;
    },
    onSuccess: (saved) => {
      // Two caches need to bust here. The list query
      // (["catalog", "products", brandId]) drives the table view in
      // ProductsTab, so invalidating it refreshes prices, names, etc.
      // BUT the single-product query (["catalog", "product", productId])
      // is what THIS form re-hydrates from on the next mount — if we
      // don't invalidate it, the operator clicks "Edit" again and sees
      // the pre-save snapshot, which manifests as "I attached modifier
      // groups to my SKUs and saved, but when I come back they're all
      // detached again". The data IS on the server (verified via curl)
      // — it's just the stale cache lying to the form.
      qc.invalidateQueries({ queryKey: ["catalog", "products", brandId] });
      qc.invalidateQueries({ queryKey: ["catalog", "product", saved.id] });
      // Phase AZ — the menu editor's product cards (and the Channel-pricing
      // modal) read brandIds off the menu detail, so refresh it too.
      qc.invalidateQueries({ queryKey: ["menu"] });
      // Also seed the single-product cache with the just-saved object so
      // a fast re-edit before the refetch completes still shows the
      // correct state instead of a flash of the stale snapshot.
      qc.setQueryData(["catalog", "product", saved.id], saved);
      onSaved();
    },
  });

  // Image used to be required at the form level; operator wants the option
  // to save without one (placeholder shown in the catalog list instead).
  const canSave = name.trim().length > 0;

  // Phase AW-18.1 — attached groups come from the item's own
  // modifierGroupLinks (server-included via /v1/items/:itemId). The
  // earlier filter-against-allGroups pattern dropped the rows whenever
  // the form's brandId disagreed with the item's brandId (e.g. a
  // HubRise-imported menu attached to a different brand at publish
  // time). Reading straight off existing.modifierGroupLinks makes
  // hydration brand-drift safe.
  const linkedGroups = useMemo(
    () =>
      ((existing as any)?.modifierGroupLinks ?? [])
        .map((l: any) => l.group)
        .filter(Boolean),
    [existing],
  );
  // The list SKU rows resolve their group ids against.
  //
  // `allGroups` is scoped to the location, and a sized product's SKU groups
  // are bare ids with no FK — an imported menu's groups often sit on another
  // brand of the same tenant and so are absent from it. The server resolves
  // them by id + tenant on the item itself; merge those in or the row cannot
  // name what is genuinely attached.
  const groupsForSkus = useMemo(() => {
    const merged = new Map<string, any>();
    for (const g of allGroups) merged.set(g.id, g);
    for (const g of (existing as any)?.skuModifierGroups ?? []) {
      if (!merged.has(g.id)) merged.set(g.id, g);
    }
    return Array.from(merged.values());
  }, [allGroups, existing]);

  const attachedGroups = useMemo(() => {
    const merged = new Map<string, any>();
    for (const g of linkedGroups) merged.set(g.id, g);
    // Operator-added (or removed) since opening: trust the local
    // attachedGroupIds set and look up via allGroups for any id the
    // server-side links don't have yet.
    for (const id of attachedGroupIds) {
      if (merged.has(id)) continue;
      const local = allGroups.find((g) => g.id === id);
      if (local) merged.set(id, local);
    }
    // Ordered BY attachedGroupIds, not by the map's insertion order. That
    // array is what the operator drags, and it is what gets sent to the
    // reorder endpoint on save — if the list rendered in the server's order
    // instead, a drag would appear to work and snap back on the next render.
    return attachedGroupIds
      .map((id) => merged.get(id))
      .filter((g: any): g is any => !!g);
  }, [linkedGroups, allGroups, attachedGroupIds]);
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
              {/* Only shown once the location turns kitchen translations on —
                  most shops print English and do not want a second name box
                  on every product. */}
              {kitchenLanguageOn && (
                <Field
                  label="Kitchen name"
                  hint="Printed on the kitchen ticket instead of the name above. Leave blank to print the English name."
                >
                  <Input
                    value={secondLanguageName}
                    onChange={(e) => setSecondLanguageName(e.target.value)}
                    placeholder="e.g. 玛格丽特披萨"
                    className="h-9 text-sm"
                  />
                </Field>
              )}
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
                        price: String(Number(basePrice) || 0),
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
                        price: String(Number(basePrice) || 0),
                        modifierGroupIds: [],
                      },
                    ])
                  }
                  className="h-8 text-xs"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add SKU
                </Button>
                {menuId && productId && skus.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setApplyError(null);
                      setApplyMode("skus");
                    }}
                    className="h-8 text-xs ml-2"
                    title="Copy these sizes (and their modifier groups) to other items in this menu"
                  >
                    <Layers className="h-3.5 w-3.5 mr-1" />
                    Apply to other items
                  </Button>
                )}
              </div>

              <div className="space-y-3">
                {skus.map((sku, i) => (
                  <SkuRow
                    key={i}
                    sku={sku}
                    basePrice={Number(basePrice) || 0}
                    money={money}
                    allGroups={groupsForSkus}
                    onChange={(next) =>
                      setSkus(skus.map((r, idx) => (idx === i ? next : r)))
                    }
                    onRemove={() =>
                      setSkus(skus.filter((_, idx) => idx !== i))
                    }
                    onAddExisting={() => setSkuAttachTarget(i)}
                    onCreateNew={() => setSkuCreateTarget(i)}
                    onEditGroup={(id) => setEditingGroupId(id)}
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
                    onClick={() => setShowCreateGroupModal(true)}
                    className="h-8 text-xs bg-zinc-900 hover:bg-zinc-800 text-white"
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Create New
                  </Button>
                  {/* Only when we know which menu we're in — the picker lists
                      that menu's items, and there's nothing to scope to when
                      the form is opened from the brand catalogue. Needs a
                      saved product too: you can't link groups to an item that
                      doesn't exist yet. */}
                  {menuId && productId && attachedGroupIds.length > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setApplyError(null);
                        setApplyMode("groups");
                      }}
                      className="h-8 text-xs"
                      title="Attach these modifier groups to other items in this menu"
                    >
                      <Layers className="h-3.5 w-3.5 mr-1" />
                      Apply to other items
                    </Button>
                  )}
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
                  attachedGroups.map((g, idx) => (
                    <div
                      key={g.id}
                      draggable
                      onDragStart={() => {
                        draggingGroupIdx.current = idx;
                      }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        const from = draggingGroupIdx.current;
                        draggingGroupIdx.current = null;
                        if (from == null || from === idx) return;
                        setAttachedGroupIds((cur) => {
                          const next = [...cur];
                          const [moved] = next.splice(from, 1);
                          if (moved) next.splice(idx, 0, moved);
                          return next;
                        });
                      }}
                      className="group flex items-center justify-between rounded bg-white border border-zinc-100 px-3 py-2 hover:border-zinc-300"
                    >
                      <span
                        className="cursor-grab pr-1.5 text-zinc-300 hover:text-zinc-600"
                        title="Drag to change the order this group is asked for"
                      >
                        <GripVertical className="h-3.5 w-3.5" />
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditingGroupId(g.id)}
                        className="min-w-0 flex-1 text-left hover:text-violet-700 transition-colors"
                        title="Click to edit this modifier group and its modifiers"
                      >
                        <p className="text-sm font-medium text-zinc-900 group-hover:text-violet-700">
                          {g.name}{" "}
                          <span className="text-[11px] font-normal text-zinc-500">
                            ({g.options?.length ?? 0} modifier
                            {g.options?.length === 1 ? "" : "s"})
                          </span>
                        </p>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          // DETACH from this product — never delete the
                          // group itself.
                          //
                          // This used to call modifierGroupsClient.remove(),
                          // which destroys the group catalogue-wide and rips
                          // it off every other product using it. Removing
                          // "Crusts" from one pizza would silently strip it
                          // from the whole menu, and there was no way back.
                          // Deleting a group belongs in the Products tab,
                          // where that is plainly what you are doing.
                          //
                          // Local only: the save mutation diffs
                          // attachedGroupIds against the server's set and
                          // issues the detach, exactly as "Add Existing"
                          // issues the attach.
                          setAttachedGroupIds((prev) =>
                            prev.filter((id) => id !== g.id),
                          );
                          toast.success(
                            `Removed "${g.name}" from this item — save to apply`,
                          );
                        }}
                        title="Remove this modifier group from this item (the group itself stays in the catalogue)"
                        className="text-zinc-300 hover:text-red-600 transition-colors ml-2"
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
                  preview: (g.options ?? []).map((o: any) => ({
                    name: o.name,
                    price: o.priceAdjustment,
                  })),
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
              <Field label="Base price ({symbol.trim()})">
                <Input
                  type="number"
                  step="0.01"
                  value={basePrice}
                  onChange={(e) => {
                    // The base is the anchor: each SKU keeps its supplement,
                    // so nudging the base moves every size with it instead of
                    // making the operator retype each one. Stored prices stay
                    // absolute; only the anchor they were derived from moved.
                    const prev = Number(basePrice) || 0;
                    const next = Number(e.target.value) || 0;
                    setBasePrice(e.target.value);
                    if (next !== prev) {
                      setSkus((cur) =>
                        cur.map((r) => ({
                          ...r,
                          price: ((Number(r.price) || 0) - prev + next).toFixed(2),
                        })),
                      );
                    }
                  }}
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

          {brands.length > 1 && (
            <Card className="p-5">
              <h3 className="text-sm font-semibold text-zinc-900 mb-1">
                Brands
              </h3>
              <p className="text-[11px] text-zinc-500 mb-3">
                Which brands sell this product. Used to keep each brand's items
                (and prices) separate when publishing to a shared HubRise
                catalog. Most products belong to one brand.
              </p>
              <div className="space-y-1.5">
                {brands.map((b) => {
                  const checked = brandIds.includes(b.id);
                  return (
                    <label
                      key={b.id}
                      className="flex items-center gap-2 rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setBrandIds(
                            e.target.checked
                              ? [...brandIds, b.id]
                              : brandIds.filter((id) => id !== b.id),
                          )
                        }
                        className="h-4 w-4 accent-violet-600"
                      />
                      {b.name}
                    </label>
                  );
                })}
              </div>
            </Card>
          )}

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

          <Card title="How it can be ordered">
            <p className="mb-3 text-xs text-zinc-500">
              Turn one off and this product stops being offered that way —
              online, on the till, and on the marketplaces we publish to.
              Everything is on unless you say otherwise.
            </p>
            <div className="space-y-3">
              <Toggle
                label="Available on collection"
                hint="Orders collected from the shop, including walk-ins at the counter."
                checked={availableCollection}
                onChange={setAvailableCollection}
              />
              <Toggle
                label="Available on delivery"
                hint="Your own drivers and the marketplaces' — anything that travels."
                checked={availableDelivery}
                onChange={setAvailableDelivery}
              />
              <Toggle
                label="Available dine-in"
                hint="Table tabs. Off for anything you only sell to take away."
                checked={availableDineIn}
                onChange={setAvailableDineIn}
              />
            </div>
            {!availableCollection && !availableDelivery && !availableDineIn && (
              // Silent otherwise: the product simply never appears anywhere,
              // and nothing on the menu shows why.
              <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                With all three off, nobody can order this — it will not appear
                on any menu, till or marketplace.
              </p>
            )}
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

      {/* Create New Modifier Group — inline modal. Embeds the full
          ModifierGroupForm so the operator gets the same editor used
          in the standalone tab (name, PLU, selection type, modifiers
          attach/inline-create) without losing the product form's
          unsaved state. On save the new group's id is appended to
          attachedGroupIds. Closes on Cancel or the backdrop. */}
      {showCreateGroupModal && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-sm py-8"
          onClick={(e) => {
            // Backdrop click closes; click inside the panel doesn't.
            if (e.target === e.currentTarget) {
              setShowCreateGroupModal(false);
            }
          }}
        >
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl mx-4 p-5">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-zinc-100">
              <h2 className="text-base font-semibold text-zinc-900">
                Create a new modifier group
              </h2>
              <button
                onClick={() => setShowCreateGroupModal(false)}
                className="text-zinc-400 hover:text-zinc-700 text-2xl leading-none"
                title="Close"
              >
                ×
              </button>
            </div>
            <ModifierGroupForm
              brandId={brandId}
              locationId={scopeLocationId}
              onCancel={() => setShowCreateGroupModal(false)}
              onSaved={(saved) => {
                if (saved?.id) {
                  // Auto-attach to this product.
                  setAttachedGroupIds((prev) =>
                    prev.includes(saved.id) ? prev : [...prev, saved.id],
                  );
                }
                setShowCreateGroupModal(false);
              }}
            />
          </div>
        </div>
      )}

      {/* Spread this item's setup across the rest of the menu. */}
      {applyMode && menuId && productId && (
        <ApplyToItemsModal
          menuId={menuId}
          sourceItemId={productId}
          sourceItemName={name}
          groupNames={
            applyMode === "groups" ? attachedGroups.map((g) => g.name) : []
          }
          skuCount={applyMode === "skus" ? skus.length : 0}
          applying={applying}
          error={applyError}
          onClose={() => {
            if (applying) return;
            setApplyMode(null);
            setApplyError(null);
          }}
          onApply={async (targetItemIds) => {
            setApplying(true);
            setApplyError(null);
            try {
              const res = await productsClient.applyToItems(productId, {
                targetItemIds,
                ...(applyMode === "groups"
                  ? { modifierGroupIds: attachedGroupIds }
                  : { includeSkus: true }),
              });
              // The menu editor's cards and every other product's form read
              // this data, so bust both — otherwise the operator opens the
              // next pizza and sees the pre-apply state. Same trap as the
              // save mutation's cache note above.
              qc.invalidateQueries({ queryKey: ["menu"] });
              qc.invalidateQueries({ queryKey: ["catalog", "products", brandId] });
              qc.invalidateQueries({ queryKey: ["catalog", "product"] });
              toast.success(
                applyMode === "groups"
                  ? `Attached to ${res.itemsUpdated} item${res.itemsUpdated === 1 ? "" : "s"}`
                  : `Copied ${skus.length} size${skus.length === 1 ? "" : "s"} to ${res.itemsUpdated} item${res.itemsUpdated === 1 ? "" : "s"}`,
              );
              setApplyMode(null);
            } catch (err: any) {
              setApplyError(
                err?.response?.data?.message ??
                  err?.message ??
                  "Couldn't apply to those items",
              );
            } finally {
              setApplying(false);
            }
          }}
        />
      )}

      {/* Phase AW-18.2 — Edit existing modifier group + its modifiers.
          Same component as Create New, just with groupId set so the
          form hydrates from /v1/modifier-groups/:id. */}
      {editingGroupId && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-sm py-8"
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditingGroupId(null);
          }}
        >
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl mx-4 p-5">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-zinc-100">
              <h2 className="text-base font-semibold text-zinc-900">
                Edit modifier group
              </h2>
              <button
                onClick={() => setEditingGroupId(null)}
                className="text-zinc-400 hover:text-zinc-700 text-2xl leading-none"
                title="Close"
              >
                ×
              </button>
            </div>
            <ModifierGroupForm
              brandId={brandId}
              locationId={scopeLocationId}
              groupId={editingGroupId}
              onCancel={() => setEditingGroupId(null)}
              onSaved={() => {
                // Refresh the brand-wide groups list so the updated
                // name + options reflect in the attached-row display.
                qc.invalidateQueries({
                  queryKey: ["catalog", "modifier-groups", scopeLocationId ?? brandId],
                });
                qc.invalidateQueries({
                  queryKey: ["catalog", "product", productId],
                });
                setEditingGroupId(null);
              }}
            />
          </div>
        </div>
      )}

      {/* Per-SKU "Add Existing" — same picker as the flat product, scoped to
          one size's modifierGroupIds. */}
      {skuAttachTarget !== null && (
        <AttachModal
          open
          title="Add Modifier Groups to this size"
          rows={allGroups.map((g) => ({
            id: g.id,
            name: g.name,
            subtitle: g.plu ?? "",
            meta: `${g.options?.length ?? 0} modifier${g.options?.length === 1 ? "" : "s"}`,
            preview: (g.options ?? []).map((o: any) => ({
              name: o.name,
              price: o.priceAdjustment,
            })),
          }))}
          initiallyAttachedIds={skus[skuAttachTarget]?.modifierGroupIds ?? []}
          onConfirm={(ids) => {
            setSkus((cur) =>
              cur.map((r, idx) =>
                idx === skuAttachTarget ? { ...r, modifierGroupIds: ids } : r,
              ),
            );
            setSkuAttachTarget(null);
          }}
          onCancel={() => setSkuAttachTarget(null)}
        />
      )}

      {/* Per-SKU "Create New" — create a group and auto-attach it to this
          size. */}
      {skuCreateTarget !== null && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-sm py-8"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSkuCreateTarget(null);
          }}
        >
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl mx-4 p-5">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-zinc-100">
              <h2 className="text-base font-semibold text-zinc-900">
                Create a new modifier group
              </h2>
              <button
                onClick={() => setSkuCreateTarget(null)}
                className="text-zinc-400 hover:text-zinc-700 text-2xl leading-none"
                title="Close"
              >
                ×
              </button>
            </div>
            <ModifierGroupForm
              brandId={brandId}
              locationId={scopeLocationId}
              onCancel={() => setSkuCreateTarget(null)}
              onSaved={(saved) => {
                if (saved?.id) {
                  const newId = saved.id;
                  setSkus((cur) =>
                    cur.map((r, idx) =>
                      idx === skuCreateTarget
                        ? {
                            ...r,
                            modifierGroupIds: r.modifierGroupIds.includes(newId)
                              ? r.modifierGroupIds
                              : [...r.modifierGroupIds, newId],
                          }
                        : r,
                    ),
                  );
                }
                qc.invalidateQueries({
                  queryKey: ["catalog", "modifier-groups", scopeLocationId ?? brandId],
                });
                setSkuCreateTarget(null);
              }}
            />
          </div>
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
  onAddExisting,
  onCreateNew,
  onEditGroup,
  basePrice,
  money,
}: {
  sku: {
    name: string;
    plu: string;
    price: string;
    modifierGroupIds: string[];
  };
  // The product's base price. SKU prices are STORED as the true total for
  // that size — every marketplace publishes absolute prices, and the POS
  // charges selectedSku.price directly — but they are EDITED here as a
  // supplement on top of the base, which is how an operator thinks about a
  // size ("make it a meal, +£3.99"). Converting at the input keeps the
  // familiar mental model without changing a single downstream price.
  basePrice: number;
  /** Bound to the location's currency by the form — never format here. */
  money: (n: number | string | null | undefined) => string;
  allGroups: import("@/lib/api/catalog.client").CatalogModifierGroup[];
  onChange: (next: {
    name: string;
    plu: string;
    price: string;
    modifierGroupIds: string[];
  }) => void;
  onRemove: () => void;
  onAddExisting: () => void;
  onCreateNew: () => void;
  onEditGroup: (groupId: string) => void;
}) {
  // Resolve in the SKU's own order, and never drop an id we can't name.
  //
  // This filtered `allGroups` — the LOCATION-scoped list — so any group the
  // list didn't contain vanished and the row said "No groups attached to this
  // size yet". An imported menu routinely references groups on another brand
  // of the same tenant, so that read "the import attached nothing" when the
  // import had attached them correctly. Four rounds of debugging went to the
  // importer because of it. An id that won't resolve is now shown as an id.
  // Which chip is being dragged. A ref for the same reason as the flat list:
  // it changes throughout a drag and re-rendering would fight the browser.
  const draggingChipIdx = useRef<number | null>(null);

  // Stored absolute -> displayed supplement. A blank box reads as +0.00, so
  // a size that costs the same as the base needs nothing typed.
  const total = Number(sku.price) || 0;
  const rawSupplement = total - basePrice;
  const supplement = Math.abs(rawSupplement) < 0.005 ? "" : rawSupplement.toFixed(2);

  // While the box has focus it holds exactly what was typed. Deriving the
  // displayed value from the stored price on every keystroke re-formatted it
  // mid-word: typing "3.99" went 3 -> "3.00" -> "3.009" -> "3.91", so each
  // extra 9 pushed another penny onto the total and the field could not be
  // typed into at all. The draft is dropped on blur, which re-syncs the box to
  // the canonical two-decimal value.
  const [draft, setDraft] = useState<string | null>(null);

  const byId = new Map(allGroups.map((g) => [g.id, g]));
  const attached = sku.modifierGroupIds.map(
    (id) => byId.get(id) ?? { id, name: null, options: [] },
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
        <div className="col-span-3">
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-zinc-400">
              +£
            </span>
            <Input
              // Text, not number: a number input reports "3." as an empty
              // value, so the half-typed state of "3.99" wiped the supplement
              // and dropped the total back to the base price. inputMode keeps
              // the numeric keypad on a tablet, which is where this is used.
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={draft ?? supplement}
              onChange={(e) => {
                // Accept only what can become a number, so stray characters
                // never reach the price. One leading minus, one dot.
                const raw = e.target.value
                  .replace(/[^0-9.-]/g, "")
                  .replace(/(?!^)-/g, "")
                  .replace(/^(-?\d*\.\d*).*$/, "$1");
                setDraft(raw);
                // "", "-" and "." are mid-typing states, not zero: hold the
                // box at what was typed and treat the supplement as nothing
                // until the number is real.
                const delta = Number(raw);
                const usable = raw !== "" && Number.isFinite(delta);
                onChange({
                  ...sku,
                  price: (basePrice + (usable ? delta : 0)).toFixed(2),
                });
              }}
              onBlur={() => setDraft(null)}
              className="h-9 pl-8 text-sm tabular-nums"
            />
          </div>
          <p
            className={
              "mt-1 text-[11px] tabular-nums " +
              (total < 0 ? "text-red-600" : "text-zinc-500")
            }
          >
            = {money(total)}
          </p>
        </div>
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
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={onAddExisting}
              className="inline-flex items-center gap-1 rounded border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:border-orange-300 hover:bg-orange-50"
            >
              <Plus className="h-3 w-3" /> Add Existing
            </button>
            <button
              type="button"
              onClick={onCreateNew}
              className="inline-flex items-center gap-1 rounded bg-zinc-900 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-zinc-800"
            >
              <Plus className="h-3 w-3" /> Create New
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {attached.map((g, idx) => (
            <span
              key={g.id}
              draggable
              onDragStart={() => {
                draggingChipIdx.current = idx;
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                const from = draggingChipIdx.current;
                draggingChipIdx.current = null;
                if (from == null || from === idx) return;
                // Order here IS the array order in productSkus[].modifierGroups,
                // so there is nothing to persist separately — it saves with the
                // product like any other SKU field.
                const next = [...sku.modifierGroupIds];
                const [moved] = next.splice(from, 1);
                if (moved) next.splice(idx, 0, moved);
                onChange({ ...sku, modifierGroupIds: next });
              }}
              className={`group inline-flex cursor-grab items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                g.name
                  ? "bg-orange-100 text-orange-800"
                  : "bg-amber-100 text-amber-900"
              }`}
              title={
                g.name
                  ? undefined
                  : "This size references a modifier group that isn't in this location's list. It's attached — it just can't be named here."
              }
            >
              <button
                type="button"
                onClick={() => onEditGroup(g.id)}
                className="hover:underline"
                title="Edit this modifier group + its modifiers"
              >
                {g.name ?? `Group ${g.id.slice(-6)}`}
                <span className="ml-1 font-normal text-orange-600">
                  ({g.options?.length ?? 0})
                </span>
              </button>
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
                title="Detach from this size"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          {attached.length === 0 && (
            <span className="text-[11px] italic text-zinc-400">
              No groups attached to this size yet — use Add Existing or Create
              New.
            </span>
          )}
        </div>
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
