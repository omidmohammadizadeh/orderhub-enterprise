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
import { SUPPORTED_COUNTRIES, dialCodeForCountry } from "@orderhub/shared";
import { useCurrency } from "@/hooks/use-currency";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Wand2, X } from "lucide-react";
import {
  locationsClient,
  brandsClient,
  type Location,
  type LocationStatus,
} from "@/lib/api/locations.client";
import { OpeningHoursEditor } from "./opening-hours-editor";
import { WhatsAppConnectionSection } from "./whatsapp-connection-section";
import { StuartConnectionSection } from "./stuart-connection-section";
import { UberDirectConnectionSection } from "./uber-direct-connection-section";
import { ImageUploader } from "@/components/products/image-uploader";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { KITCHEN_LANGUAGES } from "@/lib/kitchen-languages";

interface Props {
  locationId: string | null; // null = create
  onClose: () => void;
  onSaved: () => void;
}

type Tab = "general" | "hours";

export function LocationEditModal({ locationId, onClose, onSaved }: Props) {
  // Prices follow the selected location's currency, not a hardcoded pound.
  const { money, symbol } = useCurrency();
  const router = useRouter();
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
          {/* Brands is a page, not a tab. Wiring a marketplace means store
              ids, credentials and per-channel settings — more than fits
              beside the opening hours — so this leaves the modal rather than
              cramming a second layout in behind it. */}
          <TabBtn
            active={false}
            disabled={isCreate}
            onClick={() => {
              if (!locationId) return;
              onClose();
              router.push(`/dashboard/locations/${locationId}/brands`);
            }}
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
  // Card-reader fee. Held as strings so "" (inherit) stays distinguishable
  // from "0" (explicitly charge nothing) — the two mean different things.
  const [posTerminalFeePercent, setPosTerminalFeePercent] = useState<string>(
    (location as any)?.posTerminalApplicationFeePercent != null
      ? String((location as any).posTerminalApplicationFeePercent)
      : "",
  );
  const [posTerminalFeeFixed, setPosTerminalFeeFixed] = useState<string>(
    (location as any)?.posTerminalApplicationFeeFixedMinor != null
      ? String((location as any).posTerminalApplicationFeeFixedMinor / 100)
      : "",
  );
  // POS display name — which brand's name POS + receipts show for this
  // location's walk-in/phone orders. Empty = use the order's own brand.
  const [posBrandId, setPosBrandId] = useState<string>(
    (location as any)?.settings?.posBrandId ?? "",
  );
  // Per-location telephony identity (SMS + caller ID). Stored on
  // Location.settings; the API resolves the Twilio "From" from these so each
  // shop texts from its own number/name (see sms.service resolveFrom).
  // Kitchen tickets in a second language (e.g. an English menu with a Chinese
  // kitchen). OFF by default — nearly every shop prints English, and the
  // toggle is what keeps a second name box off every product for them.
  const [kitchenSecondLanguage, setKitchenSecondLanguage] = useState<boolean>(
    (location as any)?.settings?.kitchenTicketSecondLanguage === true,
  );
  // Free text, not a fixed list: the shops that need this know exactly what
  // their kitchen reads, and a dropdown of ten languages would be wrong for
  // the eleventh.
  const [kitchenLanguage, setKitchenLanguage] = useState<string>(
    (location as any)?.settings?.kitchenTicketLanguage ?? "",
  );
  const [smsSenderName, setSmsSenderName] = useState<string>(
    (location as any)?.settings?.smsSenderName ?? "",
  );
  const [smsNumber, setSmsNumber] = useState<string>(
    (location as any)?.settings?.smsNumber ?? "",
  );
  const [callerIdNumber, setCallerIdNumber] = useState<string>(
    (location as any)?.settings?.callerIdNumber ?? "",
  );
  // AI phone line — the Telnyx number this shop's overflow calls forward to,
  // and the kill switch. Default OFF: assigning a number must never be what
  // starts an AI answering a restaurant's phone.
  const [voiceNumber, setVoiceNumber] = useState<string>(
    (location as any)?.settings?.voiceNumber ?? "",
  );
  const [voiceAiEnabled, setVoiceAiEnabled] = useState<boolean>(
    (location as any)?.settings?.voiceAiEnabled === true,
  );
  const [voiceTransferNumber, setVoiceTransferNumber] = useState<string>(
    (location as any)?.settings?.voiceTransferNumber ?? "",
  );
  const [voiceTestMode, setVoiceTestMode] = useState<boolean>(
    (location as any)?.settings?.voiceTestMode === true,
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
        // Payment link Stripe settings (DB columns keep their historical
        // pos* names — see the section comment in the form below).
        posStripeAccountId: posStripeAccountId.trim() || null,
        posApplicationFeePercent: posFeePercent.trim()
          ? Number(posFeePercent)
          : null,
        posApplicationFeeFixedMinor: posFeeFixed.trim()
          ? Math.round(Number(posFeeFixed) * 100)
          : null,
        // Card-reader fee. Blank sends null (inherit the brand's
        // online-ordering fee); "0" sends 0 (charge nothing). Number("")
        // is 0, so the trim() check is what keeps those two apart.
        posTerminalApplicationFeePercent: posTerminalFeePercent.trim()
          ? Number(posTerminalFeePercent)
          : null,
        posTerminalApplicationFeeFixedMinor: posTerminalFeeFixed.trim()
          ? Math.round(Number(posTerminalFeeFixed) * 100)
          : null,
        // POS display name + per-location SMS/caller-ID identity — shallow-
        // merged into Location.settings.
        settings: {
          posBrandId: posBrandId || null,
          kitchenTicketSecondLanguage: kitchenSecondLanguage,
          kitchenTicketLanguage: kitchenLanguage.trim() || null,
          smsSenderName: smsSenderName.trim() || null,
          smsNumber: smsNumber.trim() || null,
          callerIdNumber: callerIdNumber.trim() || null,
          voiceNumber: voiceNumber.trim() || null,
          voiceAiEnabled: voiceAiEnabled === true,
          voiceTransferNumber: voiceTransferNumber.trim() || null,
          voiceTestMode: voiceTestMode === true,
        },
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
        <Field
          label="Country"
          help="Sets this shop's currency, timezone and which delivery channels it can connect to."
        >
          {/* A picker, not a text box. This field decides the shop's currency,
              its timezone and its channel list, and the old free-text version
              silently produced a GBP/London shop for anyone who typed "UAE" or
              "Dubai" instead of the ISO code. */}
          <select
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
          >
            {SUPPORTED_COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Phone">
          <Input
            value={phone}
            onChange={setPhone}
            placeholder={`${dialCodeForCountry(country)}…`}
          />
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

      {/* Payment link settings — the Connect account + platform fee that
          payment-link charges use for THIS location. Overrides the brand
          account so a shop's card links always land on its own Stripe.
          Historically labelled "POS Stripe settings", which read as though it
          covered card readers too; it never has. The DB columns keep their
          pos* names deliberately — this row is written by raw SQL to survive
          a stale Prisma client, and a rename is the last thing to put in
          front of that. */}
      <div className="rounded-md border border-zinc-200 p-3 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">
            Payment link settings
          </h3>
          <p className="text-[11px] text-zinc-500">
            Used only for <strong>payment link</strong> charges at this
            location — not card readers. Leave the account blank to use the
            brand&apos;s Stripe account.
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
          <Field label="Fixed fee per order ({symbol.trim()})">
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
          Platform fee per payment-link charge. Both parts come out of
          the restaurant&apos;s payout &mdash; nothing is added to the
          customer&apos;s bill, so a payment link costs the customer exactly
          the same as any other way of paying. Both optional.
        </p>
      </div>

      {/* Card-reader fee — previously shared with online ordering via the
          brand's applicationFee*, so a shop couldn't price a counter tap
          differently from a delivery order. Per-location by design: these are
          the shop's card-present takings, and a brand can span several shops. */}
      <div className="rounded-md border border-zinc-200 p-3 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">
            Card reader fee (POS terminal)
          </h3>
          <p className="text-[11px] text-zinc-500">
            Platform fee on payments taken through a card reader at this shop —
            S700, WisePad 3, and Tap to Pay on iPhone or Android.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Application fee (%)">
            <input
              type="number"
              min="0"
              step="0.01"
              value={posTerminalFeePercent}
              onChange={(e) => setPosTerminalFeePercent(e.target.value)}
              placeholder="e.g. 1.5"
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </Field>
          <Field label="Fixed fee per order ({symbol.trim()})">
            <input
              type="number"
              min="0"
              step="0.01"
              value={posTerminalFeeFixed}
              onChange={(e) => setPosTerminalFeeFixed(e.target.value)}
              placeholder="e.g. 0.10"
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </Field>
        </div>
        <p className="text-[11px] text-zinc-400">
          Leave both blank to keep using the brand&apos;s online-ordering fee
          for card readers. Enter <strong>0</strong> to charge nothing on
          terminal payments — that&apos;s different from leaving it blank.
        </p>
      </div>

      {/* Kitchen-language tickets. Off unless a shop actually needs it. */}
      <div className="rounded-md border border-zinc-200 p-3 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">
            Kitchen ticket language
          </h3>
          <p className="text-[11px] text-zinc-500">
            For a kitchen that reads a different language from the menu — an
            English menu for customers, a Chinese ticket for the kitchen.
          </p>
        </div>
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={kitchenSecondLanguage}
            onChange={(e) => setKitchenSecondLanguage(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-zinc-300"
          />
          <span className="min-w-0">
            <span className="block text-sm text-zinc-800">
              Print kitchen tickets in a second language
            </span>
            <span className="block text-[11px] text-zinc-500">
              Adds a &ldquo;Kitchen name&rdquo; box to every product. Items
              without one keep printing their English name, so you can
              translate the menu a bit at a time. Customer receipts and the
              menu itself are never affected.
            </span>
          </span>
        </label>
        {kitchenSecondLanguage && (
          <Field
            label="Kitchen language"
            help="Used when you press Translate on a menu. Start typing to find one."
          >
            <SearchableSelect
              options={KITCHEN_LANGUAGES.map((l) => ({ value: l, label: l }))}
              value={kitchenLanguage || undefined}
              onChange={(v) => setKitchenLanguage(v ?? "")}
              placeholder="Pick a language"
              searchPlaceholder="Type to find a language…"
              emptyLabel="No language matches — tell us and we'll add it"
              allowAll
              allLabel="Not set"
            />
          </Field>
        )}
      </div>

      {/* Per-location phone identity — the number/name this shop's texts and
          caller-ID use. Each client texts from its own sender. */}
      <div className="rounded-md border border-zinc-200 p-3 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">
            Phone &amp; SMS sender
          </h3>
          <p className="text-[11px] text-zinc-500">
            How this shop&apos;s texts and caller ID appear. Leave blank to use
            the platform default.
          </p>
        </div>
        <Field label="SMS sender name (shown on payment links)">
          <input
            value={smsSenderName}
            onChange={(e) => setSmsSenderName(e.target.value.slice(0, 11))}
            placeholder="e.g. PizzaUno"
            maxLength={11}
            className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
          />
        </Field>
        <p className="text-[11px] text-zinc-400">
          Up to 11 letters/numbers, must include a letter. Customers see this
          name instead of a number on payment-link texts. Note: a name-only
          sender is one-way — replies and &ldquo;STOP&rdquo; can&apos;t reach it,
          so <strong>marketing</strong> texts use the number below instead.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="SMS number (marketing & replies)">
            <input
              value={smsNumber}
              onChange={(e) => setSmsNumber(e.target.value)}
              placeholder={`${dialCodeForCountry(country)}…`}
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </Field>
          <Field label="Caller-ID number">
            <input
              value={callerIdNumber}
              onChange={(e) => setCallerIdNumber(e.target.value)}
              placeholder={`${dialCodeForCountry(country)}…`}
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </Field>
        </div>
        <p className="text-[11px] text-zinc-400">
          The SMS number must be a number in your Twilio account. Marketing texts
          send from it so customers can reply &ldquo;STOP&rdquo; to opt out.
        </p>
      </div>

      {/* AI phone line. Separate card from SMS on purpose: this is the one
          setting that makes a machine answer a restaurant's phone, and it
          should never be something an operator flips by accident while
          editing a sender name. */}
      <div className="rounded-md border border-zinc-200 p-3 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">AI phone line</h3>
          <p className="text-[11px] text-zinc-500">
            Answers calls this shop can&apos;t get to, takes the order, and puts
            it on the board. Billed per answered call from the wallet.
          </p>
        </div>
        <Field label="AI phone number">
          <input
            value={voiceNumber}
            onChange={(e) => setVoiceNumber(e.target.value)}
            placeholder={`${dialCodeForCountry(country)}…`}
            className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
          />
        </Field>
        <p className="text-[11px] text-zinc-400">
          The number the AI answers on. Don&apos;t give this to customers — set
          the shop&apos;s existing line to <strong>forward on no answer</strong>{" "}
          to it, so callers keep dialling the number they already know and the
          AI only picks up what staff couldn&apos;t.
        </p>
        <Field label="Transfer calls to">
          <input
            value={voiceTransferNumber}
            onChange={(e) => setVoiceTransferNumber(e.target.value)}
            placeholder="Defaults to this shop's phone number"
            className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
          />
        </Field>
        <p className="text-[11px] text-zinc-400">
          Where the AI sends a caller who asks for a person, complains, or wants
          something it can&apos;t do. Leave blank to use the shop&apos;s own
          number.
        </p>
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2.5">
          <input
            type="checkbox"
            checked={voiceTestMode}
            onChange={(e) => setVoiceTestMode(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-zinc-300"
          />
          <span className="text-xs text-amber-900">
            <strong>Test mode — don&apos;t charge for calls</strong>
            <span className="mt-0.5 block text-[11px] text-amber-800">
              Answers as normal but takes nothing from the wallet, and works
              even on an empty balance. For our own testing — turn it off before
              the shop goes live, or their calls are free.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 rounded-md bg-zinc-50 p-2.5">
          <input
            type="checkbox"
            checked={voiceAiEnabled}
            onChange={(e) => setVoiceAiEnabled(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-zinc-300"
          />
          <span className="text-xs text-zinc-700">
            <strong>Let the AI answer calls for this shop</strong>
            <span className="mt-0.5 block text-[11px] text-zinc-500">
              Off by default. With this off the number simply doesn&apos;t
              answer, so calls keep ringing at the shop exactly as they do now —
              switching it off is always safe.
            </span>
          </span>
        </label>
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
