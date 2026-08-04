"use client";

// Phase AW — Brand storefront settings drawer.
//
// Opens when an admin clicks Connect (or Edit) on the "Direct online
// ordering" channel in the brand's connection list. This is the one
// place to configure everything a customer sees: brand identity,
// public URL, contact, address, about copy, Stripe Connect payout.
//
// Three access tiers (mirrored server-side by @Roles):
//   • PLATFORM_ADMIN / TENANT_OWNER — everything.
//   • OWNER — the storefront settings that are theirs to run: logo, contact,
//     about, opening hours, base + busy prep time, advertised prep times,
//     online payment methods, order types, scheduling, delivery postcodes &
//     charges. Brand identity (name/cuisine), the public URL/custom domain and
//     Stripe payouts are HIDDEN from them, not just disabled.
//   • Everyone else — read-only.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X, ExternalLink, Trash2, Plus } from "lucide-react";
import {
  brandsClient,
  type Brand,
  type FeeApplyResult,
} from "@/lib/api/locations.client";
import {
  directOrderingClient,
  type DirectOrderingConfig,
  deliveryZonesClient,
  type DeliveryZone,
} from "@/lib/api/pos.client";
import { ImageUploader } from "@/components/products/image-uploader";
import { BrandCustomDomainPanel } from "./brand-custom-domain-panel";
import { useAuthStore } from "@/stores/auth.store";

const ADMIN_ROLES = new Set(["PLATFORM_ADMIN", "TENANT_OWNER"]);
// Location OWNERs edit the storefront settings that are genuinely theirs —
// logo, contact, about, opening hours, base/busy prep time, advertised prep
// times, online payment methods, order types, scheduling and delivery
// postcodes/charges. They do NOT get brand identity (name/cuisine), the public
// URL/domain, or Stripe payouts — those stay admin-only and are hidden from them.
const STOREFRONT_EDIT_ROLES = new Set([...ADMIN_ROLES, "OWNER"]);

interface Props {
  brand: Brand;
  open: boolean;
  onClose: () => void;
  // Hook for parent so it can refetch its brand list after save.
  onSaved?: (updated: Brand) => void;
}

export function BrandSettingsDrawer({ brand, open, onClose, onSaved }: Props) {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user && ADMIN_ROLES.has(user.role as string);
  const canEdit = !!user && STOREFRONT_EDIT_ROLES.has(user.role as string);
  const qc = useQueryClient();

  // ── Identity ──────────────────────────────────────────────────────
  const [name, setName] = useState(brand.name);
  const [cuisine, setCuisine] = useState(brand.cuisine ?? "");
  const [logoUrl, setLogoUrl] = useState<string | null>(brand.logoUrl ?? null);

  // ── Storefront URL ────────────────────────────────────────────────
  const [orderingSlug, setOrderingSlug] = useState(brand.onlineOrderingSlug ?? "");
  const [slugErr, setSlugErr] = useState<string | null>(null);

  // ── Contact + address ─────────────────────────────────────────────
  const [phone, setPhone] = useState(brand.phone ?? "");
  const [addressLine1, setAddressLine1] = useState(brand.addressLine1 ?? "");
  const [addressLine2, setAddressLine2] = useState(brand.addressLine2 ?? "");
  const [city, setCity] = useState(brand.city ?? "");
  const [postcode, setPostcode] = useState(brand.postcode ?? "");

  // ── About copy ────────────────────────────────────────────────────
  const [about, setAbout] = useState(brand.about ?? "");

  // ── Stripe Connect ────────────────────────────────────────────────
  const [stripeAccountId, setStripeAccountId] = useState(
    brand.stripeConnectedAccountId ?? "",
  );
  const [appFeeMode, setAppFeeMode] = useState(brand.applicationFeeMode ?? "none");
  const [appFeeFixed, setAppFeeFixed] = useState<string>(
    brand.applicationFeeFixedAmount?.toString() ?? "",
  );
  const [appFeePct, setAppFeePct] = useState<string>(
    brand.applicationFeePercentage?.toString() ?? "",
  );
  // "Apply this fee to all brands" — preview held here until confirmed.
  const [feePreview, setFeePreview] = useState<FeeApplyResult | null>(null);
  const [applyFeeError, setApplyFeeError] = useState<string | null>(null);
  const [applyFeeDone, setApplyFeeDone] = useState<string | null>(null);
  const applyFee = useMutation({
    mutationFn: (confirm: boolean) =>
      brandsClient.applyFeeToAll(brand.id, !confirm),
    onMutate: () => {
      setApplyFeeError(null);
      setApplyFeeDone(null);
    },
    onSuccess: (res) => {
      if (!res.applied) {
        setFeePreview(res);
        return;
      }
      setFeePreview(null);
      setApplyFeeDone(
        `Applied to ${res.changes.length} brand${res.changes.length === 1 ? "" : "s"}.`,
      );
      qc.invalidateQueries({ queryKey: ["brands"] });
    },
    onError: (e: any) => {
      setFeePreview(null);
      setApplyFeeError(
        e?.response?.data?.message ?? e?.message ?? "Couldn't apply the fee.",
      );
    },
  });
  // Phase AW-16 — brand-level opening hours + prep time. openingHours
  // is a map { monday: [{from, to}, ...], … } mirroring HubRise's
  // shape. Empty defaults so the operator can fill them in.
  const DAYS = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ] as const;
  type Day = (typeof DAYS)[number];
  const [openingHours, setOpeningHours] = useState<
    Record<Day, Array<{ from: string; to: string }>>
  >(() => {
    const src = (brand.openingHours ?? {}) as any;
    const out: Record<Day, Array<{ from: string; to: string }>> = {
      monday: [], tuesday: [], wednesday: [], thursday: [],
      friday: [], saturday: [], sunday: [],
    };
    for (const d of DAYS) {
      if (Array.isArray(src[d])) out[d] = src[d];
    }
    return out;
  });
  // Copy one day's slots onto other days — retyping the same 09:00–21:00
  // seven times was the #1 gripe with this editor. Targets: every day,
  // Mon–Fri, Sat–Sun, or a single day. Slots are deep-copied so editing
  // Tuesday later never mutates Monday's objects.
  const copyDayHours = (
    from: Day,
    target: "all" | "weekdays" | "weekend" | Day,
  ) => {
    const targets: readonly Day[] =
      target === "all"
        ? DAYS
        : target === "weekdays"
          ? (["monday", "tuesday", "wednesday", "thursday", "friday"] as const)
          : target === "weekend"
            ? (["saturday", "sunday"] as const)
            : [target];
    const next = { ...openingHours };
    for (const d of targets) {
      if (d === from) continue;
      next[d] = openingHours[from].map((s) => ({ ...s }));
    }
    setOpeningHours(next);
  };

  const [prepTime, setPrepTime] = useState<string>(
    brand.prepTime != null ? String(brand.prepTime) : "",
  );
  const [busyExtraPrepTime, setBusyExtraPrepTime] = useState<string>(
    brand.busyExtraPrepTime != null ? String(brand.busyExtraPrepTime) : "",
  );

  // ── Phase AW — Direct online ordering config (moved off the
  //    location-level sidebar tab). Per-brand prep times, accepted
  //    payment methods, accepted order types, scheduling window, and
  //    min order. Loaded once via brand-keyed endpoint, saved
  //    independently from the identity fields so a partial form
  //    submit doesn't blow away one or the other.
  const cfgQuery = useQuery<DirectOrderingConfig>({
    queryKey: ["brand-direct-ordering", brand.id],
    queryFn: () => directOrderingClient.getByBrand(brand.id),
    enabled: open,
  });
  const [deliveryPrep, setDeliveryPrep] = useState("");
  const [collectionPrep, setCollectionPrep] = useState("");
  const [acceptsCash, setAcceptsCash] = useState(true);
  const [acceptsCard, setAcceptsCard] = useState(true);
  const [acceptsDelivery, setAcceptsDelivery] = useState(true);
  const [acceptsCollection, setAcceptsCollection] = useState(true);
  const [scheduleDays, setScheduleDays] = useState("7");
  const [slotMins, setSlotMins] = useState("15");
  const [minDelivery, setMinDelivery] = useState("");
  const [showItemImages, setShowItemImages] = useState(true);
  useEffect(() => {
    const c = cfgQuery.data;
    if (!c) return;
    setDeliveryPrep(String(c.deliveryPrepMinutes));
    setCollectionPrep(String(c.collectionPrepMinutes));
    setAcceptsCash(c.acceptsCash);
    setAcceptsCard(c.acceptsCard);
    setAcceptsDelivery(c.acceptsDelivery);
    setAcceptsCollection(c.acceptsCollection);
    setScheduleDays(String(c.scheduleMaxDaysAhead));
    setSlotMins(String(c.scheduleSlotMinutes));
    setMinDelivery(
      c.minOrderForDelivery != null ? String(c.minOrderForDelivery) : "",
    );
    setShowItemImages(c.showItemImages ?? true);
  }, [cfgQuery.data]);

  // Re-seed state when the user reopens with a fresh row (different brand
  // or a refetch). Without this the modal keeps stale values from the
  // previous brand.
  useEffect(() => {
    if (!open) return;
    setName(brand.name);
    setCuisine(brand.cuisine ?? "");
    setLogoUrl(brand.logoUrl ?? null);
    setOrderingSlug(brand.onlineOrderingSlug ?? "");
    setPhone(brand.phone ?? "");
    setAddressLine1(brand.addressLine1 ?? "");
    setAddressLine2(brand.addressLine2 ?? "");
    setCity(brand.city ?? "");
    setPostcode(brand.postcode ?? "");
    setAbout(brand.about ?? "");
    setStripeAccountId(brand.stripeConnectedAccountId ?? "");
    setAppFeeMode(brand.applicationFeeMode ?? "none");
    setAppFeeFixed(brand.applicationFeeFixedAmount?.toString() ?? "");
    setAppFeePct(brand.applicationFeePercentage?.toString() ?? "");
    setSlugErr(null);
  }, [open, brand]);

  const publicUrl = useMemo(() => {
    if (!orderingSlug || typeof window === "undefined") return "";
    return `${window.location.origin}/brand/${orderingSlug}`;
  }, [orderingSlug]);

  // Server-mints the slug — keeps the global-unique check on one side.
  const generateSlug = useMutation({
    mutationFn: () => brandsClient.setSlug(brand.id, null),
    onSuccess: (updated) => {
      setOrderingSlug(updated.onlineOrderingSlug ?? "");
      setSlugErr(null);
    },
    onError: (e: any) =>
      setSlugErr(e?.response?.data?.message ?? "Failed to generate slug"),
  });

  const save = useMutation({
    // Phase AW — save brand identity + direct-ordering config in one
    // click. Promise.all so a flake on one doesn't half-save the
    // other; the brand-keyed DirectOrderingConfig endpoint is an
    // upsert so the first save creates the row.
    mutationFn: () =>
      Promise.all([
        brandsClient.update(brand.id, {
          name,
          cuisine: cuisine || null,
          logoUrl: logoUrl ?? null,
          onlineOrderingSlug: orderingSlug || null,
          directOrderingEnabled: !!orderingSlug,
          phone: phone || null,
          addressLine1: addressLine1 || null,
          addressLine2: addressLine2 || null,
          city: city || null,
          postcode: postcode || null,
          about: about || null,
          stripeConnectedAccountId: stripeAccountId || null,
          applicationFeeMode: appFeeMode,
          applicationFeeFixedAmount: appFeeFixed ? Number(appFeeFixed) : null,
          applicationFeePercentage: appFeePct ? Number(appFeePct) : null,
          openingHours,
          prepTime: prepTime ? Number(prepTime) : null,
          busyExtraPrepTime: busyExtraPrepTime
            ? Number(busyExtraPrepTime)
            : null,
        }),
        directOrderingClient.updateByBrand(brand.id, {
          deliveryPrepMinutes: Number(deliveryPrep) || 0,
          collectionPrepMinutes: Number(collectionPrep) || 0,
          acceptsCash,
          acceptsCard,
          acceptsDelivery,
          acceptsCollection,
          scheduleMaxDaysAhead: Number(scheduleDays) || 7,
          scheduleSlotMinutes: Number(slotMins) || 15,
          minOrderForDelivery: minDelivery ? Number(minDelivery) : null,
          showItemImages,
        }),
      ]).then(([updated]) => updated),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["brands"] });
      qc.invalidateQueries({ queryKey: ["brand-connections", brand.id] });
      qc.invalidateQueries({ queryKey: ["brand-direct-ordering", brand.id] });
      onSaved?.(updated);
      onClose();
    },
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-zinc-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              {brand.name} — online ordering
            </h2>
            <p className="text-[11px] text-zinc-500">
              Customer-facing identity for this brand. Used on the storefront,
              receipts, and platform payouts.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {!canEdit && (
          <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-[11px] text-amber-800">
            Read-only — only Tenant Owners and Platform Admins can edit
            brand storefront settings.
          </div>
        )}

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {/* ── Identity ─────────────────────────────────────────── */}
          <Section title={isAdmin ? "Identity" : "Logo"}>
            {/* Brand name + cuisine are brand identity — admin only. Owners
                get the logo, which is theirs to manage. */}
            {isAdmin && (
              <>
                <Field label="Brand name">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={!canEdit}
                    className="input"
                  />
                </Field>
                <Field label="Cuisine">
                  <input
                    value={cuisine}
                    onChange={(e) => setCuisine(e.target.value)}
                    disabled={!canEdit}
                    placeholder="e.g. Pizza, Burgers, Greek"
                    className="input"
                  />
                </Field>
              </>
            )}
            <Field label="Logo">
              <p className="mb-2 text-[11px] text-zinc-500">
                Printed on the receipt header and shown on the storefront.
                A square logo works best — the whole image is kept, never
                cropped.
              </p>
              <ImageUploader
                value={logoUrl}
                onChange={(v: string | null) => canEdit && setLogoUrl(v)}
                targetWidth={512}
                targetHeight={512}
                fit="contain"
              />
            </Field>
          </Section>

          {/* ── Storefront URL — admin only (slug + custom domain are
              platform-level, so owners don't see this at all). ──── */}
          {isAdmin && (
          <Section title="Public URL">
            <Field label="Slug">
              <div className="flex gap-2">
                <input
                  value={orderingSlug}
                  onChange={(e) => setOrderingSlug(e.target.value)}
                  disabled={!canEdit}
                  placeholder="e.g. greek-gyros-pelton"
                  className="input flex-1"
                />
                <button
                  type="button"
                  onClick={() => generateSlug.mutate()}
                  disabled={!isAdmin || generateSlug.isPending}
                  className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                >
                  {generateSlug.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    "Generate"
                  )}
                </button>
              </div>
              {slugErr && (
                <p className="mt-1 text-[11px] text-red-600">{slugErr}</p>
              )}
              {publicUrl && (
                <p className="mt-1.5 truncate text-[11px] text-zinc-500">
                  Available at{" "}
                  <a
                    href={publicUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-violet-600 hover:underline"
                  >
                    {publicUrl}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </p>
              )}
            </Field>
            <BrandCustomDomainPanel brandId={brand.id} disabled={!canEdit} />
          </Section>
          )}

          {/* ── Contact + address ────────────────────────────────── */}
          <Section title="Contact">
            <Field label="Phone">
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={!canEdit}
                placeholder="+44 …"
                className="input"
              />
            </Field>
            <Field label="Address line 1">
              <input
                value={addressLine1}
                onChange={(e) => setAddressLine1(e.target.value)}
                disabled={!canEdit}
                className="input"
              />
            </Field>
            <Field label="Address line 2">
              <input
                value={addressLine2}
                onChange={(e) => setAddressLine2(e.target.value)}
                disabled={!canEdit}
                className="input"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="City">
                <input
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  disabled={!canEdit}
                  className="input"
                />
              </Field>
              <Field label="Postcode">
                <input
                  value={postcode}
                  onChange={(e) => setPostcode(e.target.value)}
                  disabled={!canEdit}
                  className="input"
                />
              </Field>
            </div>
          </Section>

          {/* ── About ────────────────────────────────────────────── */}
          <Section title="About">
            <Field label="Short pitch shown above the menu">
              <textarea
                value={about}
                onChange={(e) => setAbout(e.target.value)}
                disabled={!canEdit}
                rows={3}
                placeholder="Family-run pizzeria. Wood-fired. Open till midnight."
                className="input resize-none"
              />
            </Field>
          </Section>

          {/* ── Stripe Connect — admin only (payouts). Hidden from
              owners entirely. ─────────────────────────────────────── */}
          {isAdmin && (
          <Section title="Stripe Connect (payouts)">
            <p className="text-[11px] text-zinc-500">
              Each brand can receive payouts to its own Stripe account. Leave
              blank to fall through to the location's Stripe settings.
            </p>
            <Field label="Connected account id">
              <input
                value={stripeAccountId}
                onChange={(e) => setStripeAccountId(e.target.value)}
                disabled={!canEdit}
                placeholder="acct_…"
                className="input font-mono"
              />
            </Field>
            <Field label="Application fee mode">
              <select
                value={appFeeMode}
                onChange={(e) => setAppFeeMode(e.target.value)}
                disabled={!canEdit}
                className="input"
              >
                <option value="none">None</option>
                <option value="fixed_only">Fixed amount</option>
                <option value="percentage_only">Percentage</option>
                <option value="fixed_and_percentage">Fixed + percentage</option>
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Fixed (£)">
                <input
                  value={appFeeFixed}
                  onChange={(e) => setAppFeeFixed(e.target.value)}
                  disabled={!canEdit}
                  type="number"
                  step="0.01"
                  className="input"
                />
              </Field>
              <Field label="Percentage (%)">
                <input
                  value={appFeePct}
                  onChange={(e) => setAppFeePct(e.target.value)}
                  disabled={!canEdit}
                  type="number"
                  step="0.01"
                  className="input"
                />
              </Field>
            </div>

            {/* Roll this fee out to the rest of the estate.
                There is no location-level fee form anywhere, so a brand
                nobody configured charges nothing at all — which is how a
                live site can take card orders for weeks with no platform
                fee on any of them. Preview first, then apply. */}
            <div className="mt-4 border-t border-zinc-100 pt-3">
              {feePreview ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-[12px] text-amber-900">
                  {feePreview.changes.length === 0 ? (
                    <p>
                      Every other brand already charges this fee. Nothing to
                      change.
                    </p>
                  ) : (
                    <>
                      <p className="font-semibold">
                        Change the fee on {feePreview.changes.length} brand
                        {feePreview.changes.length === 1 ? "" : "s"} to{" "}
                        {describeFee(
                          feePreview.source.mode,
                          feePreview.source.fixed,
                          feePreview.source.percentage,
                        )}
                        ?
                      </p>
                      <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto">
                        {feePreview.changes.map((c) => (
                          <li key={c.id} className="flex justify-between gap-3">
                            <span className="truncate">{c.name}</span>
                            <span className="shrink-0 tabular-nums opacity-80">
                              {describeFee(
                                c.from.mode,
                                c.from.fixed,
                                c.from.percentage,
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {feePreview.unchanged > 0 && (
                        <p className="mt-2 opacity-80">
                          {feePreview.unchanged} already match.
                        </p>
                      )}
                      <p className="mt-2">
                        This changes what every location earns per card order.
                      </p>
                    </>
                  )}
                  <div className="mt-3 flex gap-2">
                    {feePreview.changes.length > 0 && (
                      <button
                        type="button"
                        disabled={applyFee.isPending}
                        onClick={() => applyFee.mutate(true)}
                        className="rounded-md bg-amber-700 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-amber-800 disabled:opacity-60"
                      >
                        {applyFee.isPending ? "Applying…" : "Yes, apply to all"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setFeePreview(null)}
                      className="rounded-md border border-amber-300 px-3 py-1.5 text-[12px] font-semibold hover:bg-amber-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={!canEdit || appFeeMode === "none" || applyFee.isPending}
                    onClick={() => applyFee.mutate(false)}
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-[12px] font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                  >
                    {applyFee.isPending ? "Checking…" : "Apply this fee to all brands"}
                  </button>
                  <p className="mt-1.5 text-[11px] text-zinc-500">
                    {appFeeMode === "none"
                      ? "Set a fee above first — there's nothing to copy."
                      : "Save your changes first, then copy this fee to every other brand. You'll see exactly what changes before anything is written."}
                  </p>
                  {applyFeeError && (
                    <p className="mt-1.5 text-[11px] text-red-600">{applyFeeError}</p>
                  )}
                  {applyFeeDone && (
                    <p className="mt-1.5 text-[11px] text-green-700">{applyFeeDone}</p>
                  )}
                </>
              )}
            </div>
          </Section>
          )}

          {/* ── Opening hours + base prep time (Phase AW-16) ─────── */}
          <Section title="Opening hours + prep time">
            <p className="text-[11px] text-zinc-500 mb-3">
              Per-brand schedule. Published to HubRise via the
              &ldquo;Publish hours&rdquo; button on the Menu page.
            </p>
            <div className="space-y-2">
              {DAYS.map((day) => (
                <div key={day} className="flex items-center gap-2">
                  <span className="w-20 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    {day}
                  </span>
                  <div className="flex flex-1 flex-col gap-1">
                    {openingHours[day].length === 0 ? (
                      <button
                        type="button"
                        onClick={() =>
                          canEdit &&
                          setOpeningHours({
                            ...openingHours,
                            [day]: [{ from: "09:00", to: "21:00" }],
                          })
                        }
                        disabled={!canEdit}
                        className="rounded-md border border-dashed border-zinc-300 px-2 py-1 text-left text-[11px] text-zinc-500 hover:border-zinc-400 disabled:opacity-50"
                      >
                        Closed — tap to add hours
                      </button>
                    ) : (
                      openingHours[day].map((slot, idx) => (
                        <div key={idx} className="flex items-center gap-1.5">
                          <input
                            type="time"
                            value={slot.from}
                            onChange={(e) => {
                              const copy = { ...openingHours };
                              copy[day] = [...copy[day]];
                              copy[day][idx] = { ...slot, from: e.target.value };
                              setOpeningHours(copy);
                            }}
                            disabled={!canEdit}
                            className="input"
                          />
                          <span className="text-[11px] text-zinc-400">→</span>
                          <input
                            type="time"
                            value={slot.to}
                            onChange={(e) => {
                              const copy = { ...openingHours };
                              copy[day] = [...copy[day]];
                              copy[day][idx] = { ...slot, to: e.target.value };
                              setOpeningHours(copy);
                            }}
                            disabled={!canEdit}
                            className="input"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const copy = { ...openingHours };
                              copy[day] = copy[day].filter((_, i) => i !== idx);
                              setOpeningHours(copy);
                            }}
                            disabled={!canEdit}
                            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 disabled:opacity-50"
                            title="Remove slot"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))
                    )}
                    {openingHours[day].length > 0 && (
                      <div className="flex items-center gap-1.5 self-start">
                        <button
                          type="button"
                          onClick={() =>
                            canEdit &&
                            setOpeningHours({
                              ...openingHours,
                              [day]: [
                                ...openingHours[day],
                                { from: "18:00", to: "23:00" },
                              ],
                            })
                          }
                          disabled={!canEdit}
                          className="rounded-md border border-zinc-200 px-2 py-0.5 text-[10px] font-medium text-zinc-500 hover:bg-zinc-50 disabled:opacity-50"
                        >
                          + Add another slot
                        </button>
                        {/* Copy this day's hours to other days — resets to the
                            placeholder after applying so it reads as an action,
                            not a persisted setting. */}
                        <select
                          value=""
                          onChange={(e) => {
                            const v = e.target.value;
                            if (!v || !canEdit) return;
                            copyDayHours(
                              day,
                              v as "all" | "weekdays" | "weekend" | Day,
                            );
                          }}
                          disabled={!canEdit}
                          className="rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 hover:bg-zinc-50 disabled:opacity-50"
                          title="Copy these hours to other days"
                        >
                          <option value="" disabled>
                            Copy to…
                          </option>
                          <option value="all">All days</option>
                          <option value="weekdays">Weekdays (Mon–Fri)</option>
                          <option value="weekend">Weekend (Sat–Sun)</option>
                          {DAYS.filter((d) => d !== day).map((d) => (
                            <option key={d} value={d}>
                              {d.charAt(0).toUpperCase() + d.slice(1)}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Field label="Base prep time (minutes)">
                <input
                  value={prepTime}
                  onChange={(e) => setPrepTime(e.target.value)}
                  disabled={!canEdit}
                  type="number"
                  min={0}
                  className="input"
                />
              </Field>
              <Field label="Busy mode adds (minutes)">
                <input
                  value={busyExtraPrepTime}
                  onChange={(e) => setBusyExtraPrepTime(e.target.value)}
                  disabled={!canEdit}
                  type="number"
                  min={0}
                  className="input"
                />
              </Field>
            </div>
          </Section>

          {/* ── Storefront behaviour (moved from sidebar tab) ───── */}
          <Section title="Prep times advertised to customers">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Delivery (mins)">
                <input
                  value={deliveryPrep}
                  onChange={(e) => setDeliveryPrep(e.target.value)}
                  disabled={!canEdit}
                  type="number"
                  min="0"
                  className="input"
                />
              </Field>
              <Field label="Collection (mins)">
                <input
                  value={collectionPrep}
                  onChange={(e) => setCollectionPrep(e.target.value)}
                  disabled={!canEdit}
                  type="number"
                  min="0"
                  className="input"
                />
              </Field>
            </div>
          </Section>

          <Section title="Payment methods accepted online">
            <ToggleRow
              label="Accept cash on delivery / collection"
              value={acceptsCash}
              onChange={setAcceptsCash}
              disabled={!canEdit}
            />
            <ToggleRow
              label="Accept card online (Stripe)"
              value={acceptsCard}
              onChange={setAcceptsCard}
              disabled={!canEdit}
            />
          </Section>

          <Section title="Order types accepted online">
            <ToggleRow
              label="Accept delivery orders"
              value={acceptsDelivery}
              onChange={setAcceptsDelivery}
              disabled={!canEdit}
            />
            <ToggleRow
              label="Accept collection orders"
              value={acceptsCollection}
              onChange={setAcceptsCollection}
              disabled={!canEdit}
            />
          </Section>

          <Section title="Menu display">
            <ToggleRow
              label="Show item photos on the storefront"
              value={showItemImages}
              onChange={setShowItemImages}
              disabled={!canEdit}
            />
            <p className="mt-1 text-[11px] text-zinc-500">
              Off = a clean, text-only menu (no product images). Useful when you
              don&rsquo;t have good photos for every item.
            </p>
          </Section>

          <Section title="Scheduling">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Days ahead">
                <input
                  value={scheduleDays}
                  onChange={(e) => setScheduleDays(e.target.value)}
                  disabled={!canEdit}
                  type="number"
                  min="0"
                  className="input"
                />
              </Field>
              <Field label="Slot mins">
                <input
                  value={slotMins}
                  onChange={(e) => setSlotMins(e.target.value)}
                  disabled={!canEdit}
                  type="number"
                  min="0"
                  className="input"
                />
              </Field>
              <Field label="Min delivery (£)">
                <input
                  value={minDelivery}
                  onChange={(e) => setMinDelivery(e.target.value)}
                  disabled={!canEdit}
                  type="number"
                  min="0"
                  step="0.01"
                  className="input"
                />
              </Field>
            </div>
          </Section>

          <Section title="Delivery postcodes & charges">
            <p className="mb-2 text-[11px] text-zinc-500">
              Customers entering one of these postcode prefixes get the
              matching delivery fee. The longest matching prefix wins
              (so &ldquo;SW1A&rdquo; beats &ldquo;SW&rdquo;).
            </p>
            <DeliveryZonesEditor brandId={brand.id} isAdmin={canEdit} />
          </Section>

          {save.isError && (
            <p className="text-[12px] text-red-600">
              {(save.error as any)?.response?.data?.message ?? "Save failed"}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-zinc-200 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={!canEdit || save.isPending || !name.trim()}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {save.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              "Save settings"
            )}
          </button>
        </footer>

        <style jsx>{`
          .input {
            width: 100%;
            border-radius: 0.375rem;
            border: 1px solid rgb(228 228 231);
            padding: 0.375rem 0.5rem;
            font-size: 0.875rem;
            line-height: 1.25rem;
          }
          .input:focus {
            outline: none;
            border-color: rgb(24 24 27);
          }
          .input:disabled {
            background-color: rgb(250 250 250);
            color: rgb(113 113 122);
          }
        `}</style>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-zinc-200 bg-white p-4">
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-700">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {label}
      </label>
      {children}
    </div>
  );
}

function DeliveryZonesEditor({
  brandId,
  isAdmin,
}: {
  brandId: string;
  isAdmin: boolean;
}) {
  const qc = useQueryClient();
  const zonesQuery = useQuery<DeliveryZone[]>({
    queryKey: ["brand-delivery-zones", brandId],
    queryFn: () => deliveryZonesClient.listByBrand(brandId),
  });

  const [newPrefix, setNewPrefix] = useState("");
  const [newFee, setNewFee] = useState("");
  const [newMin, setNewMin] = useState("");

  const create = useMutation({
    mutationFn: () =>
      deliveryZonesClient.create({
        brandId,
        postcodePrefix: newPrefix.trim().toUpperCase(),
        fee: Number(newFee) || 0,
        minOrderValue: newMin ? Number(newMin) : undefined,
      }),
    onSuccess: () => {
      setNewPrefix("");
      setNewFee("");
      setNewMin("");
      qc.invalidateQueries({ queryKey: ["brand-delivery-zones", brandId] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deliveryZonesClient.remove(id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["brand-delivery-zones", brandId] }),
  });

  const toggleActive = useMutation({
    mutationFn: (z: DeliveryZone) =>
      deliveryZonesClient.update(z.id, { isActive: !z.isActive }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["brand-delivery-zones", brandId] }),
  });

  const zones = zonesQuery.data ?? [];

  return (
    <div className="space-y-2">
      {zonesQuery.isLoading ? (
        <p className="text-[11px] text-zinc-500">Loading…</p>
      ) : zones.length === 0 ? (
        <p className="text-[11px] text-zinc-500">
          No postcodes configured yet. Add one below.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-100 rounded border border-zinc-200">
          {zones.map((z) => (
            <li
              key={z.id}
              className="flex items-center gap-2 px-2 py-1.5 text-xs"
            >
              <span className="w-24 font-mono font-semibold tracking-wider text-zinc-900">
                {z.postcodePrefix}
              </span>
              <span className="w-20 text-zinc-700">£{Number(z.fee).toFixed(2)}</span>
              <span className="flex-1 text-zinc-500">
                {z.minOrderValue != null
                  ? `min £${Number(z.minOrderValue).toFixed(2)}`
                  : "no min"}
              </span>
              <button
                type="button"
                disabled={!isAdmin}
                onClick={() => toggleActive.mutate(z)}
                className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                  z.isActive
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-zinc-100 text-zinc-500"
                } disabled:opacity-50`}
              >
                {z.isActive ? "Active" : "Paused"}
              </button>
              <button
                type="button"
                disabled={!isAdmin}
                onClick={() => remove.mutate(z.id)}
                className="text-zinc-400 hover:text-red-600 disabled:opacity-50"
                aria-label="Delete"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2 pt-1">
        <Field label="Postcode">
          <input
            value={newPrefix}
            onChange={(e) => setNewPrefix(e.target.value)}
            placeholder="SW1A"
            disabled={!isAdmin}
            className="input"
          />
        </Field>
        <Field label="Fee (£)">
          <input
            value={newFee}
            onChange={(e) => setNewFee(e.target.value)}
            placeholder="3.50"
            type="number"
            min="0"
            step="0.01"
            disabled={!isAdmin}
            className="input"
          />
        </Field>
        <Field label="Min order (£)">
          <input
            value={newMin}
            onChange={(e) => setNewMin(e.target.value)}
            placeholder="optional"
            type="number"
            min="0"
            step="0.01"
            disabled={!isAdmin}
            className="input"
          />
        </Field>
        <button
          type="button"
          onClick={() => create.mutate()}
          disabled={
            !isAdmin || create.isPending || !newPrefix.trim() || !newFee
          }
          className="inline-flex h-[34px] items-center gap-1 rounded-md bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {create.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <>
              <Plus className="h-3.5 w-3.5" />
              Add
            </>
          )}
        </button>
      </div>
      {create.isError && (
        <p className="text-[11px] text-red-600">
          {(create.error as any)?.response?.data?.message ?? "Add failed"}
        </p>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center justify-between py-1.5 text-xs">
      <span className="text-zinc-700">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        disabled={disabled}
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
          value ? "bg-emerald-500" : "bg-zinc-300"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            value ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </label>
  );
}

/** "5% + £0.50", "£0.50", "5%", or "No fee" — for the apply-to-all preview. */
function describeFee(mode: string, fixed: number, percentage: number): string {
  const parts: string[] = [];
  if (mode === "percentage_only" || mode === "fixed_and_percentage") {
    if (percentage) parts.push(`${percentage}%`);
  }
  if (mode === "fixed_only" || mode === "fixed_and_percentage") {
    if (fixed) parts.push(`£${Number(fixed).toFixed(2)}`);
  }
  return parts.length ? parts.join(" + ") : "No fee";
}
