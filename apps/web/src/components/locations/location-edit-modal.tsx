"use client";

// Phase AN — Tabbed Location create/edit modal.
//
// Three tabs:
//   1. General — name, address, phone, about, logo, custom domain, slug,
//      Stripe Connect account, application-fee mode + amounts
//   2. Opening Hours — embeds the same OpeningHoursEditor used in the
//      standalone drawer
//   3. Brands — list of brands attached to this location with quick create
//
// Tab 1 is the only one available when CREATING a location (no id yet);
// tabs 2 + 3 appear after first save.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Wand2, X } from "lucide-react";
import {
  locationsClient,
  brandsClient,
  type Location,
  type LocationStatus,
  type AppFeeMode,
} from "@/lib/api/locations.client";
import { OpeningHoursEditor } from "./opening-hours-editor";
import { BrandPlatformGrid } from "./brand-platform-grid";
import { ImageUploader } from "@/components/products/image-uploader";

interface Props {
  locationId: string | null; // null = create
  onClose: () => void;
  onSaved: () => void;
}

type Tab = "general" | "hours" | "brands";

export function LocationEditModal({ locationId, onClose, onSaved }: Props) {
  const isCreate = locationId === null;
  const [tab, setTab] = useState<Tab>("general");

  const detailQuery = useQuery({
    queryKey: ["locations", "detail", locationId],
    queryFn: () => locationsClient.get(locationId!),
    enabled: !isCreate,
  });

  return (
    <Backdrop onClose={onClose}>
      <div
        className="flex h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">
              {isCreate ? "Add location" : detailQuery.data?.name ?? "Location"}
            </h2>
            {!isCreate && (
              <p className="text-xs text-zinc-500">
                {detailQuery.data?.brand?.name ?? "Brand"}
              </p>
            )}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Tabs */}
        <nav className="flex gap-1 border-b border-zinc-200 px-4">
          <TabBtn active={tab === "general"} onClick={() => setTab("general")}>
            General
          </TabBtn>
          <TabBtn
            active={tab === "hours"}
            disabled={isCreate}
            onClick={() => setTab("hours")}
          >
            Opening hours
          </TabBtn>
          <TabBtn
            active={tab === "brands"}
            disabled={isCreate}
            onClick={() => setTab("brands")}
          >
            Brands
          </TabBtn>
        </nav>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === "general" && (
            <GeneralTab
              location={detailQuery.data ?? null}
              isCreate={isCreate}
              onSaved={onSaved}
            />
          )}
          {tab === "hours" && locationId && (
            <OpeningHoursEditor locationId={locationId} />
          )}
          {tab === "brands" && locationId && (
            <BrandsTab locationId={locationId} />
          )}
        </div>
      </div>
    </Backdrop>
  );
}

// ── General tab ───────────────────────────────────────────────────────────

function GeneralTab({
  location,
  isCreate,
  onSaved,
}: {
  location: Location | null;
  isCreate: boolean;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  // No brand dropdown on the create form anymore — the API picks/creates a
  // default brand for the tenant and the operator adds real brands later
  // from the Brands section.

  const [name, setName] = useState(location?.name ?? "");
  const [line1, setLine1] = useState(location?.addressLine1 ?? "");
  const [line2, setLine2] = useState(location?.addressLine2 ?? "");
  const [city, setCity] = useState(location?.city ?? "");
  const [postcode, setPostcode] = useState(location?.postcode ?? "");
  const [country, setCountry] = useState(location?.country ?? "GB");
  const [phone, setPhone] = useState(location?.phone ?? "");
  const [about, setAbout] = useState(location?.about ?? "");
  const [logoUrl, setLogoUrl] = useState(location?.logoUrl ?? "");
  const [customDomain, setCustomDomain] = useState(location?.customDomain ?? "");
  const [slug, setSlug] = useState(location?.onlineOrderingSlug ?? "");
  const [stripeAcct, setStripeAcct] = useState(location?.stripeConnectedAccountId ?? "");
  const [feeMode, setFeeMode] = useState<AppFeeMode>(location?.applicationFeeMode ?? "none");
  const [fixedFee, setFixedFee] = useState(
    location?.applicationFeeFixedAmount != null
      ? String(location.applicationFeeFixedAmount)
      : "",
  );
  const [pctFee, setPctFee] = useState(
    location?.applicationFeePercentage != null
      ? String(location.applicationFeePercentage)
      : "",
  );
  const [status, setStatus] = useState<LocationStatus>(location?.status ?? "active");
  const [error, setError] = useState<string | null>(null);

  // Live preview of the online ordering URL using the runtime origin.
  const liveUrl = useMemo(() => {
    if (!slug || typeof window === "undefined") return "";
    return `${window.location.origin}/order/${slug}`;
  }, [slug]);

  const create = useMutation({
    mutationFn: () =>
      // No fields required other than name — the backend defaults
      // brand, address parts, and timezone when omitted.
      locationsClient.create({
        name,
        address:
          line1 || line2 || city || postcode || country !== "GB"
            ? {
                line1: line1 || undefined,
                line2: line2 || undefined,
                city: city || undefined,
                postcode: postcode || undefined,
                country: country || undefined,
              }
            : undefined,
        phone: phone || undefined,
      } as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["locations"] });
      onSaved();
    },
    onError: (err: any) => setError(err?.response?.data?.message ?? err.message),
  });

  const update = useMutation({
    mutationFn: () =>
      locationsClient.update(location!.id, {
        name,
        addressLine1: line1,
        addressLine2: line2 || null,
        city,
        postcode,
        country,
        phone: phone || null,
        about: about || null,
        logoUrl: logoUrl || null,
        customDomain: customDomain || null,
        onlineOrderingSlug: slug || null,
        stripeConnectedAccountId: stripeAcct || null,
        applicationFeeMode: feeMode,
        applicationFeeFixedAmount: fixedFee ? Number(fixedFee) : null,
        applicationFeePercentage: pctFee ? Number(pctFee) : null,
        status,
      } as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["locations"] });
      onSaved();
    },
    onError: (err: any) => setError(err?.response?.data?.message ?? err.message),
  });

  const generateSlug = useMutation({
    mutationFn: () => locationsClient.generateSlug(location!.id, name),
    onSuccess: (res) => {
      setSlug(res.slug);
      qc.invalidateQueries({ queryKey: ["locations"] });
    },
  });

  const submit = () => {
    setError(null);
    if (isCreate) create.mutate();
    else update.mutate();
  };

  const saving = create.isPending || update.isPending;

  return (
    <div className="space-y-4 text-sm">
      {/* Name — the only field with a soft requirement. Everything below
          is optional, fill in over time. Brands are added later from
          the Brands section so the create form stays a single short
          form. */}
      <Field label="Location name" help="Only field required to create.">
        <Input value={name} onChange={setName} placeholder="e.g. KLO Consett" />
      </Field>

      {/* Address */}
      <Field label="Address line 1">
        <Input value={line1} onChange={setLine1} placeholder="e.g. 14 High Street" />
      </Field>
      <Field label="Address line 2">
        <Input value={line2} onChange={setLine2} placeholder="Optional" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="City">
          <Input value={city} onChange={setCity} placeholder="Consett" />
        </Field>
        <Field label="Postcode">
          <Input value={postcode} onChange={(v) => setPostcode(v.toUpperCase())} placeholder="DH8 5AA" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Country">
          <Input value={country} onChange={setCountry} placeholder="GB" />
        </Field>
        <Field label="Phone">
          <Input value={phone} onChange={setPhone} placeholder="+44…" />
        </Field>
      </div>

      {/* About + logo */}
      <Field label="About (customer-facing description)">
        <textarea
          value={about}
          onChange={(e) => setAbout(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
        />
      </Field>
      <Field
        label="Logo"
        help="Optional. Recommended square aspect; we resize to 1064×768 with letterboxing if needed."
      >
        <ImageUploader
          value={logoUrl || null}
          onChange={(v) => setLogoUrl(v ?? "")}
        />
      </Field>

      {/* Phase AN follow-up: show ALL General fields on both create AND
          edit. Slug generation is disabled until the location exists
          since it needs an id to call the API. */}
      <Field
        label="Custom domain (optional)"
        help="e.g. order.mylocation.com — DNS verification ships in a later phase."
      >
        <Input value={customDomain} onChange={setCustomDomain} placeholder="order.mylocation.com" />
      </Field>
      <Field
        label="Online ordering URL"
        help={
          isCreate
            ? "Generate available after the location is created."
            : "Customers will visit this URL to place online orders."
        }
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400 whitespace-nowrap">/order/</span>
          <input
            value={slug}
            onChange={(e) =>
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
            }
            placeholder={isCreate ? "auto-generated" : "klo-consett"}
            disabled={isCreate}
            className="flex-1 rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none disabled:bg-zinc-50"
          />
          <button
            type="button"
            onClick={() => generateSlug.mutate()}
            disabled={isCreate || generateSlug.isPending || !name}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
          >
            {generateSlug.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Wand2 className="h-3 w-3" />
            )}
            Generate
          </button>
        </div>
        {liveUrl && !isCreate && (
          <p className="mt-1 text-[11px] text-zinc-500">
            Public URL:{" "}
            <a href={liveUrl} target="_blank" rel="noreferrer" className="underline">
              {liveUrl}
            </a>
          </p>
        )}
      </Field>

      {/* Stripe Connect + fees */}
      <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Stripe Connect
        </h3>
        <Field label="Connected account ID">
          <Input value={stripeAcct} onChange={setStripeAcct} placeholder="acct_…" />
        </Field>

        <Field label="Application fee mode" help={feeModeHelp(feeMode)}>
          <select
            value={feeMode}
            onChange={(e) => setFeeMode(e.target.value as AppFeeMode)}
            className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
          >
            <option value="none">None</option>
            <option value="fixed_only">Fixed amount (added to customer total)</option>
            <option value="percentage_only">Percentage (deducted from merchant payout)</option>
            <option value="fixed_and_percentage">Both fixed + percentage</option>
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Fixed app fee (£)">
            <Input
              value={fixedFee}
              onChange={setFixedFee}
              placeholder="0.50"
              disabled={feeMode === "none" || feeMode === "percentage_only"}
            />
          </Field>
          <Field label="Percentage app fee (%)">
            <Input
              value={pctFee}
              onChange={setPctFee}
              placeholder="5"
              disabled={feeMode === "none" || feeMode === "fixed_only"}
            />
          </Field>
        </div>
      </div>

      <Field label="Status">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as LocationStatus)}
          className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
        >
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="closed">Closed</option>
        </select>
      </Field>

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      )}

      <div className="flex justify-end gap-2 border-t border-zinc-200 pt-3">
        <button
          onClick={submit}
          disabled={saving || !name.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {isCreate ? "Create location" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

function feeModeHelp(mode: AppFeeMode): string {
  switch (mode) {
    case "fixed_only":
      return "Fixed fee is added to the customer bill. Example: £10 + £0.50 = customer pays £10.50, OrderHub keeps £0.50.";
    case "percentage_only":
      return "Percentage fee is deducted from the merchant payout. Example: £10 basket, 5% → customer pays £10, merchant receives £9.50.";
    case "fixed_and_percentage":
      return "Fixed adds to customer total; percentage is deducted from the merchant payout.";
    default:
      return "No application fee charged.";
  }
}

// ── Brands tab ────────────────────────────────────────────────────────────

function BrandsTab({ locationId }: { locationId: string }) {
  const qc = useQueryClient();
  const brandsQuery = useQuery({
    queryKey: ["brands", "location", locationId],
    queryFn: () => brandsClient.list(locationId),
  });
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => brandsClient.create({ name: newName, primaryLocationId: locationId }),
    onSuccess: () => {
      setNewName("");
      qc.invalidateQueries({ queryKey: ["brands"] });
    },
    onError: (err: any) => setError(err?.response?.data?.message ?? err.message),
  });

  const brands = brandsQuery.data ?? [];

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-zinc-500">
        Brands operating from this location. Add virtual brands (ghost kitchens)
        or franchise parents. Channel connections for each brand appear below.
      </p>

      {brands.length === 0 && !brandsQuery.isLoading && (
        <div className="rounded-md border border-dashed border-zinc-200 px-4 py-8 text-center">
          <p className="text-sm font-medium text-zinc-700">No brands yet</p>
          <p className="mt-1 text-xs text-zinc-500">
            Create a brand below. Channel connections show up once a brand exists.
          </p>
        </div>
      )}

      {/* Each brand's platform grid is scoped to that brand at THIS
          location only — connections never leak across brands or
          locations. */}
      {brands.map((b) => (
        <details key={b.id} className="overflow-hidden rounded-md border border-zinc-200">
          <summary className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-zinc-50">
            {b.logoUrl ? (
              <img src={b.logoUrl} alt="" className="h-7 w-7 rounded object-cover" />
            ) : (
              <div className="grid h-7 w-7 place-items-center rounded bg-zinc-100 text-[10px] font-semibold text-zinc-500">
                {b.name.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="flex-1">
              <div className="text-xs font-semibold text-zinc-900">{b.name}</div>
              {b.description && (
                <div className="text-[10px] text-zinc-500 truncate">{b.description}</div>
              )}
            </div>
            <span className="text-[10px] text-zinc-400">
              {b._count?.platformConnections ?? 0} channels
            </span>
          </summary>
          <div className="border-t border-zinc-200 p-3">
            <p className="mb-2 text-[10px] uppercase tracking-wider text-zinc-400">
              Channel connections for {b.name}
            </p>
            <BrandPlatformGrid brandId={b.id} locationId={locationId} />
          </div>
        </details>
      ))}

      {/* Quick create */}
      <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Add brand at this location
        </p>
        <div className="flex gap-2">
          <Input value={newName} onChange={setNewName} placeholder="e.g. Crunchy Chikin" />
          <button
            onClick={() => create.mutate()}
            disabled={create.isPending || !newName}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {create.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
          </button>
        </div>
        {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
      </div>
    </div>
  );
}

// ── Atoms ────────────────────────────────────────────────────────────────

function Field({
  label,
  children,
  help,
}: {
  label: string;
  children: React.ReactNode;
  help?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      {children}
      {help && <p className="mt-1 text-[11px] text-zinc-500">{help}</p>}
    </label>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none disabled:bg-zinc-50"
    />
  );
}

function TabBtn({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-2 text-xs font-medium border-b-2 disabled:opacity-40 ${
        active
          ? "border-zinc-900 text-zinc-900"
          : "border-transparent text-zinc-500 hover:text-zinc-700"
      }`}
    >
      {children}
    </button>
  );
}

function Backdrop({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      {children}
    </div>
  );
}
