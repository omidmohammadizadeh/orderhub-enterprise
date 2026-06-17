"use client";

// Phase AW — Brand storefront settings drawer.
//
// Opens when an admin clicks Connect (or Edit) on the "Direct online
// ordering" channel in the brand's connection list. This is the one
// place to configure everything a customer sees: brand identity,
// public URL, contact, address, about copy, Stripe Connect payout.
//
// Admin-only on the client too (the server already gates the slug
// generation + Stripe fields via @Roles). Non-admins get a read-only
// view so a manager who lands here on an existing brand can still
// inspect, just can't change anything that affects payouts.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, X, ExternalLink } from "lucide-react";
import { brandsClient, type Brand } from "@/lib/api/locations.client";
import { ImageUploader } from "@/components/products/image-uploader";
import { useAuthStore } from "@/stores/auth.store";

const ADMIN_ROLES = new Set(["PLATFORM_ADMIN", "TENANT_OWNER"]);

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
  const qc = useQueryClient();

  // ── Identity ──────────────────────────────────────────────────────
  const [name, setName] = useState(brand.name);
  const [cuisine, setCuisine] = useState(brand.cuisine ?? "");
  const [logoUrl, setLogoUrl] = useState<string | null>(brand.logoUrl ?? null);

  // ── Storefront URL ────────────────────────────────────────────────
  const [orderingSlug, setOrderingSlug] = useState(brand.onlineOrderingSlug ?? "");
  const [customDomain, setCustomDomain] = useState(brand.customDomain ?? "");
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

  // Re-seed state when the user reopens with a fresh row (different brand
  // or a refetch). Without this the modal keeps stale values from the
  // previous brand.
  useEffect(() => {
    if (!open) return;
    setName(brand.name);
    setCuisine(brand.cuisine ?? "");
    setLogoUrl(brand.logoUrl ?? null);
    setOrderingSlug(brand.onlineOrderingSlug ?? "");
    setCustomDomain(brand.customDomain ?? "");
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
    mutationFn: () =>
      brandsClient.update(brand.id, {
        name,
        cuisine: cuisine || null,
        logoUrl: logoUrl ?? null,
        onlineOrderingSlug: orderingSlug || null,
        directOrderingEnabled: !!orderingSlug,
        customDomain: customDomain || null,
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
      }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["brands"] });
      qc.invalidateQueries({ queryKey: ["brand-connections", brand.id] });
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

        {!isAdmin && (
          <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-[11px] text-amber-800">
            Read-only — only Tenant Owners and Platform Admins can edit
            brand storefront settings.
          </div>
        )}

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {/* ── Identity ─────────────────────────────────────────── */}
          <Section title="Identity">
            <Field label="Brand name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!isAdmin}
                className="input"
              />
            </Field>
            <Field label="Cuisine">
              <input
                value={cuisine}
                onChange={(e) => setCuisine(e.target.value)}
                disabled={!isAdmin}
                placeholder="e.g. Pizza, Burgers, Greek"
                className="input"
              />
            </Field>
            <Field label="Logo">
              <p className="mb-2 text-[11px] text-zinc-500">
                Printed on the receipt header and shown on the storefront.
                2:1 landscape works best.
              </p>
              <ImageUploader
                value={logoUrl}
                onChange={(v: string | null) => isAdmin && setLogoUrl(v)}
                targetWidth={512}
                targetHeight={256}
              />
            </Field>
          </Section>

          {/* ── Storefront URL ──────────────────────────────────── */}
          <Section title="Public URL">
            <Field label="Slug">
              <div className="flex gap-2">
                <input
                  value={orderingSlug}
                  onChange={(e) => setOrderingSlug(e.target.value)}
                  disabled={!isAdmin}
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
            <Field label="Custom domain (optional)">
              <input
                value={customDomain}
                onChange={(e) => setCustomDomain(e.target.value)}
                disabled={!isAdmin}
                placeholder="order.greekgyros.co.uk"
                className="input"
              />
              <p className="mt-1 text-[11px] text-zinc-500">
                Point the domain at our CNAME — we'll provision an SSL
                certificate once DNS verifies.
              </p>
            </Field>
          </Section>

          {/* ── Contact + address ────────────────────────────────── */}
          <Section title="Contact">
            <Field label="Phone">
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={!isAdmin}
                placeholder="+44 …"
                className="input"
              />
            </Field>
            <Field label="Address line 1">
              <input
                value={addressLine1}
                onChange={(e) => setAddressLine1(e.target.value)}
                disabled={!isAdmin}
                className="input"
              />
            </Field>
            <Field label="Address line 2">
              <input
                value={addressLine2}
                onChange={(e) => setAddressLine2(e.target.value)}
                disabled={!isAdmin}
                className="input"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="City">
                <input
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  disabled={!isAdmin}
                  className="input"
                />
              </Field>
              <Field label="Postcode">
                <input
                  value={postcode}
                  onChange={(e) => setPostcode(e.target.value)}
                  disabled={!isAdmin}
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
                disabled={!isAdmin}
                rows={3}
                placeholder="Family-run pizzeria. Wood-fired. Open till midnight."
                className="input resize-none"
              />
            </Field>
          </Section>

          {/* ── Stripe Connect ───────────────────────────────────── */}
          <Section title="Stripe Connect (payouts)">
            <p className="text-[11px] text-zinc-500">
              Each brand can receive payouts to its own Stripe account. Leave
              blank to fall through to the location's Stripe settings.
            </p>
            <Field label="Connected account id">
              <input
                value={stripeAccountId}
                onChange={(e) => setStripeAccountId(e.target.value)}
                disabled={!isAdmin}
                placeholder="acct_…"
                className="input font-mono"
              />
            </Field>
            <Field label="Application fee mode">
              <select
                value={appFeeMode}
                onChange={(e) => setAppFeeMode(e.target.value)}
                disabled={!isAdmin}
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
                  disabled={!isAdmin}
                  type="number"
                  step="0.01"
                  className="input"
                />
              </Field>
              <Field label="Percentage (%)">
                <input
                  value={appFeePct}
                  onChange={(e) => setAppFeePct(e.target.value)}
                  disabled={!isAdmin}
                  type="number"
                  step="0.01"
                  className="input"
                />
              </Field>
            </div>
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
            disabled={!isAdmin || save.isPending || !name.trim()}
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
