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
} from "@/lib/api/locations.client";
import { OpeningHoursEditor } from "./opening-hours-editor";
import { BrandPlatformGrid } from "./brand-platform-grid";
import { WhatsAppConnectionSection } from "./whatsapp-connection-section";
import { StuartConnectionSection } from "./stuart-connection-section";
import { UberDirectConnectionSection } from "./uber-direct-connection-section";
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
            // For edit mode we hold the General tab until the detail
            // query lands so the form mounts with real values and not
            // empty defaults. Create mode mounts immediately.
            isCreate ? (
              <GeneralTab location={null} isCreate onSaved={onSaved} />
            ) : detailQuery.isLoading ? (
              <p className="py-10 text-center text-xs text-zinc-400">Loading…</p>
            ) : detailQuery.error || !detailQuery.data ? (
              <div className="space-y-3 py-8 text-center">
                <p className="text-xs text-red-600">
                  {(detailQuery.error as any)?.response?.data?.message ??
                    (detailQuery.error as any)?.message ??
                    "Failed to load location"}
                </p>
                <button
                  onClick={() => detailQuery.refetch()}
                  className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs hover:bg-zinc-50"
                >
                  Retry
                </button>
              </div>
            ) : (
              <GeneralTab
                location={detailQuery.data}
                isCreate={false}
                onSaved={onSaved}
              />
            )
          )}
          {tab === "hours" && locationId && (
            <div className="space-y-5">
              <OpeningHoursEditor locationId={locationId} />
              <PrepTimeSection locationId={locationId} />
            </div>
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
  // Phase AW — customDomain, stripeConnectedAccountId, and the
  // applicationFee* fields moved onto the brand. State + UI for them
  // is gone; the brand settings drawer is the single source of truth.
  const [googleReviewUrl, setGoogleReviewUrl] = useState(
    location?.googleReviewUrl ?? "",
  );
  const [slug, setSlug] = useState(location?.onlineOrderingSlug ?? "");
  const [status, setStatus] = useState<LocationStatus>(location?.status ?? "active");
  // POS Stripe settings — the Connect account + platform fee used by POS
  // "Payment link" charges at this location. Fixed fee held in £ for the input,
  // converted to pence on save.
  const [posStripeAccountId, setPosStripeAccountId] = useState<string>(
    (location as any)?.posStripeAccountId ?? "",
  );
  const [posFeePercent, setPosFeePercent] = useState<string>(
    (location as any)?.posApplicationFeePercent != null
      ? String((location as any).posApplicationFeePercent)
      : "",
  );
  const [posFeeFixed, setPosFeeFixed] = useState<string>(
    (location as any)?.posApplicationFeeFixedMinor != null
      ? String((location as any).posApplicationFeeFixedMinor / 100)
      : "",
  );
  // POS display name — which brand's name POS + receipts show for this
  // location's walk-in/phone orders. Empty = use the order's own brand.
  const [posBrandId, setPosBrandId] = useState<string>(
    (location as any)?.settings?.posBrandId ?? "",
  );
  const posBrandsQuery = useQuery({
    queryKey: ["brands", "location", location?.id, "pos-display"],
    queryFn: () => brandsClient.list(location!.id),
    enabled: !!location?.id,
  });
  const posBrands = posBrandsQuery.data ?? [];
  // Phase AU — HubRise per-location settings. We never load the raw
  // access token back from the server (it's encrypted and write-only).
  // `hubriseConnected` is the boolean the API returns so we can show
  // a "Connected" pill without exposing the secret.
  const [hubriseAccessToken, setHubriseAccessToken] = useState("");
  const [hubriseCatalogId, setHubriseCatalogId] = useState(
    (location as any)?.hubriseCatalogId ?? "",
  );
  const [hubriseLocationId, setHubriseLocationId] = useState(
    (location as any)?.hubriseLocationId ?? "",
  );
  const hubriseConnected = !!(location as any)?.hubriseConnected;
  // Inline state for the Connect button so the operator sees what's
  // happening without having to scroll to the modal-level error toast.
  const [hubriseBusy, setHubriseBusy] = useState(false);
  const [hubriseError, setHubriseError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Live preview of the online ordering URL using the runtime origin.
  const liveUrl = useMemo(() => {
    if (!slug || typeof window === "undefined") return "";
    return `${window.location.origin}/order/${slug}`;
  }, [slug]);

  const create = useMutation({
    mutationFn: async () => {
      // No fields required other than name — the backend defaults
      // brand, address parts, and timezone when omitted.
      const created = await locationsClient.create({
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
      } as any);

      // CreateLocationDto on the API is intentionally minimal (name +
      // address + phone). Everything else the General tab can collect
      // (about, logoUrl, customDomain, Stripe Connect, application
      // fees, status) is sent as a follow-up PATCH so the new row
      // captures the full form state in a single user action. Without
      // this, hitting Save on a brand-new location silently dropped
      // the logo and every other extended field.
      const extras: Parameters<typeof locationsClient.update>[1] = {};
      if (about) extras.about = about;
      if (logoUrl) extras.logoUrl = logoUrl;
      if (googleReviewUrl) extras.googleReviewUrl = googleReviewUrl;
      if (status !== "active") extras.status = status;
      if (Object.keys(extras).length > 0) {
        await locationsClient.update(created.id, extras as any);
      }
      return created;
    },
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
        googleReviewUrl: googleReviewUrl || null,
        onlineOrderingSlug: slug || null,
        status,
        // Phase AU — HubRise. Only send the access token when the
        // operator typed a new one (so we don't accidentally clobber
        // a stored token with the empty input field). Catalog id is
        // safe to round-trip on every save.
        ...(hubriseAccessToken.trim()
          ? { hubriseAccessToken: hubriseAccessToken.trim() }
          : {}),
        hubriseCatalogId: hubriseCatalogId || null,
        hubriseLocationId: hubriseLocationId || null,
        // POS "Payment link" Stripe settings.
        posStripeAccountId: posStripeAccountId.trim() || null,
        posApplicationFeePercent: posFeePercent.trim()
          ? Number(posFeePercent)
          : null,
        posApplicationFeeFixedMinor: posFeeFixed.trim()
          ? Math.round(Number(posFeeFixed) * 100)
          : null,
        // POS display name — shallow-merged into Location.settings.
        settings: { posBrandId: posBrandId || null },
      } as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["locations"] });
      onSaved();
    },
    onError: (err: any) => setError(err?.response?.data?.message ?? err.message),
  });

  const generateSlug = useMutation({
    mutationFn: async () => {
      if (!location?.id) {
        throw new Error("Save the location first, then click Generate.");
      }
      return locationsClient.generateSlug(location.id, name || location.name);
    },
    onSuccess: (res) => {
      setSlug(res.slug);
      setError(null);
      qc.invalidateQueries({ queryKey: ["locations"] });
      qc.invalidateQueries({ queryKey: ["locations", "detail", location?.id] });
    },
    onError: (err: any) =>
      setError(
        err?.response?.data?.message ??
          err?.message ??
          "Failed to generate URL",
      ),
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

      {/* POS display name — brand whose name POS + receipts show for this
          location's walk-in/phone orders. Only when editing (needs brands). */}
      {location?.id && (
        <Field
          label="POS display name"
          help="Which brand's name POS and printed receipts show for this location's walk-in & phone orders. Leave as 'Order's own brand' to use whichever brand the menu belongs to."
        >
          <select
            value={posBrandId}
            onChange={(e) => setPosBrandId(e.target.value)}
            className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
          >
            <option value="">Order&rsquo;s own brand (default)</option>
            {posBrands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field
        label="Logo"
        help="Optional. Recommended square aspect; we resize to 1064×768 with letterboxing if needed."
      >
        <ImageUploader
          value={logoUrl || null}
          onChange={(v) => setLogoUrl(v ?? "")}
        />
      </Field>

      {/* Phase AW — Custom domain moved onto the Brand settings drawer.
          Each brand now owns its own customer-facing URL + domain, so
          a single kitchen with three brands no longer collapses to one
          shared domain. Location keeps only the kitchen-ops fields. */}

      {/* Phase AP-5 — Google Business Profile review URL. Surfaced on
          the customer "My Orders" card as a "Leave Google review"
          button after a delivered order. Get the URL from Google
          Business Profile → "Get more reviews" → "Share review form". */}
      <Field
        label="Google review link (optional)"
        help="From Google Business Profile → Get more reviews → Share review form. Customers see a 'Leave Google review' button on their completed orders."
      >
        <Input
          value={googleReviewUrl}
          onChange={setGoogleReviewUrl}
          placeholder="https://g.page/r/..."
        />
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

      {/* Phase AU — HubRise. Per-location because the access token is
          generated against a specific HubRise location outside our app.
          The token field is write-only — we never reload it from the
          server, just show "Connected" when one is stored. Operator
          must regenerate + paste again to rotate. */}
      <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            HubRise integration
          </h3>
          {hubriseConnected && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
              ● Connected
            </span>
          )}
        </div>
        <p className="text-[11px] text-zinc-500">
          HubRise injects orders from Just Eat, Uber Eats, Deliveroo,
          and other channels you've connected on their side. The
          recommended setup is one-click: we'll send you to HubRise,
          you approve, and the token + webhook are wired automatically.
        </p>
        {location?.id && (
          <div className="space-y-1.5">
            <button
              type="button"
              disabled={hubriseBusy}
              onClick={async () => {
                setHubriseError(null);
                setHubriseBusy(true);
                try {
                  const { hubriseClient } = await import(
                    "@/lib/api/hubrise.client"
                  );
                  const url = await hubriseClient.connect(location.id);
                  if (!url) {
                    throw new Error(
                      "API returned no authorize URL — is the backend deployed?",
                    );
                  }
                  window.location.href = url;
                } catch (err: any) {
                  setHubriseError(
                    err?.response?.data?.message ??
                      err?.message ??
                      "Could not open HubRise. Check the server logs.",
                  );
                  setHubriseBusy(false);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {hubriseBusy
                ? "Opening HubRise…"
                : hubriseConnected
                  ? "Reconnect with HubRise"
                  : "Connect with HubRise"}
            </button>
            {hubriseError && (
              <p className="text-[11px] text-red-600">{hubriseError}</p>
            )}
          </div>
        )}
        <details className="mt-2 rounded-md border border-zinc-200 bg-white p-2">
          <summary className="cursor-pointer text-[11px] font-semibold text-zinc-700">
            Advanced — paste token manually
          </summary>
          <div className="mt-2 space-y-3">
        <Field label="HubRise Access Token" help={
          hubriseConnected
            ? "A token is already stored. Paste a new one to rotate, or leave blank to keep it."
            : "Generated against a HubRise location (terminal/curl). Stored encrypted."
        }>
          {/* The Input wrapper doesn't support type="password" yet —
              use a raw input so token paste is masked. */}
          <input
            type="password"
            value={hubriseAccessToken}
            onChange={(e) => setHubriseAccessToken(e.target.value)}
            placeholder={hubriseConnected ? "•••••••••• (paste to replace)" : "ohr_…"}
            className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
          />
        </Field>
          <Field label="HubRise Catalog ID" help="The menu HubRise will sync against.">
            <Input
              value={hubriseCatalogId}
              onChange={setHubriseCatalogId}
              placeholder="cat_…"
            />
          </Field>
          <Field
            label="HubRise Location ID"
            help="HubRise's own location identifier — required for menu publish, order status update, inventory 86, and pause/resume. Auto-filled when you Connect with HubRise."
          >
            <Input
              value={hubriseLocationId}
              onChange={setHubriseLocationId}
              placeholder="loc_…"
            />
          </Field>
          </div>
        </details>
      </div>

      {/* Phase AY (P6) — per-location WhatsApp activation. */}
      {location?.id && <WhatsAppConnectionSection locationId={location.id} />}

      {/* Phase BH — per-location Stuart courier dispatch. */}
      {location?.id && <StuartConnectionSection locationId={location.id} />}

      {/* Phase BI — per-location Uber Direct courier dispatch. */}
      {location?.id && <UberDirectConnectionSection locationId={location.id} />}

      {/* Phase AW — Stripe Connect + application fee live on the brand,
          not the location. A single kitchen running three virtual brands
          now routes payouts to three separate Stripe accounts; the old
          location-level fields were a footgun (the first brand's payout
          settings silently applied to all sibling brands). Edit per
          brand under Brands tab → Direct online ordering → Settings. */}
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-800">
        <strong>Moved.</strong> Stripe Connect and the application-fee
        settings now live on each brand individually. Open the Brands
        tab, expand a brand, and click Connect on the "Direct online
        ordering" channel to configure payouts.
      </div>

      {/* POS Stripe settings — the Connect account + platform fee that POS
          "Payment link" charges use for THIS location. Overrides the brand
          account so a shop's card links always land on its own Stripe. */}
      <div className="rounded-md border border-zinc-200 p-3 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">
            POS Stripe settings
          </h3>
          <p className="text-[11px] text-zinc-500">
            Used for POS <strong>Payment link</strong> charges at this location.
            Leave blank to use the brand&apos;s Stripe account.
          </p>
        </div>
        <Field label="Stripe connected account ID">
          <input
            value={posStripeAccountId}
            onChange={(e) => setPosStripeAccountId(e.target.value)}
            placeholder="acct_..."
            className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Application fee (%)">
            <input
              type="number"
              min="0"
              step="0.01"
              value={posFeePercent}
              onChange={(e) => setPosFeePercent(e.target.value)}
              placeholder="e.g. 2.5"
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </Field>
          <Field label="Fixed fee per order (£)">
            <input
              type="number"
              min="0"
              step="0.01"
              value={posFeeFixed}
              onChange={(e) => setPosFeeFixed(e.target.value)}
              placeholder="e.g. 0.20"
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </Field>
        </div>
        <p className="text-[11px] text-zinc-400">
          Platform fee taken per payment-link charge = percentage of the order
          total plus the fixed amount. Both optional.
        </p>
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

// Phase AW — feeModeHelp() retired alongside the Stripe Connect block.
// Brand settings drawer hosts the equivalent copy.

// ── Prep time (location-level) ─────────────────────────────────────────────
// Mirrors the brand online-ordering modal's prep section. HubRise + WhatsApp
// fall back to these when the brand hasn't set its own prep/hours.
function PrepTimeSection({ locationId }: { locationId: string }) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ["locations", "detail", locationId],
    queryFn: () => locationsClient.get(locationId),
  });
  const [prep, setPrep] = useState("");
  const [busy, setBusy] = useState("");
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (detail.data && !seeded) {
      setPrep(detail.data.prepTime != null ? String(detail.data.prepTime) : "");
      setBusy(
        detail.data.busyExtraPrepTime != null
          ? String(detail.data.busyExtraPrepTime)
          : "",
      );
      setSeeded(true);
    }
  }, [detail.data, seeded]);

  const save = useMutation({
    mutationFn: () =>
      locationsClient.update(locationId, {
        prepTime: prep === "" ? null : Number(prep),
        busyExtraPrepTime: busy === "" ? null : Number(busy),
      } as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["locations", "detail", locationId] });
      qc.invalidateQueries({ queryKey: ["locations"] });
    },
  });

  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">
        Prep time
      </h3>
      <p className="mb-3 text-[11px] text-zinc-500">
        Used by HubRise and WhatsApp when this brand has no prep time of its
        own. Minutes.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Base prep time (mins)">
          <input
            type="number"
            min="0"
            value={prep}
            onChange={(e) => setPrep(e.target.value)}
            placeholder="15"
            className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm tabular-nums focus:border-zinc-900 focus:outline-none"
          />
        </Field>
        <Field label="Busy mode adds (mins)">
          <input
            type="number"
            min="0"
            value={busy}
            onChange={(e) => setBusy(e.target.value)}
            placeholder="10"
            className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm tabular-nums focus:border-zinc-900 focus:outline-none"
          />
        </Field>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save prep time
        </button>
      </div>
      {save.isError && (
        <p className="mt-1 text-[11px] text-red-600">
          {(save.error as any)?.response?.data?.message ??
            (save.error as any)?.message ??
            "Failed to save"}
        </p>
      )}
    </div>
  );
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
            <BrandPlatformGrid brand={b} locationId={locationId} />
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
  // Note: we deliberately render as <div>, not <label>. A wrapping label
  // bubbles every click inside its children to whatever form control
  // it's labelling — so clicking the ImageUploader's dropzone fires
  // BOTH the dropzone's own `fileInput.click()` AND the implicit
  // `<label>` re-click on the hidden <input type="file">, opening the
  // OS file picker twice. The visible <span> with the label text is
  // enough; users associate it visually with the next field.
  return (
    <div className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      {children}
      {help && <p className="mt-1 text-[11px] text-zinc-500">{help}</p>}
    </div>
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
