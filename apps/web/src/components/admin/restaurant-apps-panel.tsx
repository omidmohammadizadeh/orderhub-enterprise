"use client";

// Admin Dashboard → Restaurant apps.
//
// Two jobs for each restaurant's own app:
//   1. Store & promotion — its Play / App Store listing, and whether the
//      storefront, Apple's Smart App Banner and the confirmation email send
//      customers to it. Off until switched on (an app still in internal
//      testing has a Play link that 404s for the public).
//   2. iPhone onboarding — the app goes out on the restaurant's OWN Apple
//      developer account (App Store guideline 4.2.6). The guide says what the
//      restaurant does and what we do; per brand we keep their Apple ids, a
//      progress checklist, and can copy them personalised instructions.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Apple,
  Check,
  ChevronDown,
  ClipboardCopy,
  ImageOff,
  Loader2,
  Megaphone,
  MapPin,
  Search,
  Smartphone,
} from "lucide-react";
import toast from "react-hot-toast";
import {
  socialLoginClient,
  type BrandShopOption,
  type CustomerAppStore,
  type IosOnboarding,
  type SocialLoginAdminRow,
} from "@/lib/api/social-login.client";
import { apiErrorMessage } from "@/lib/api/email-marketing.client";

const STEPS: { key: keyof IosOnboarding["steps"]; title: string; who: "Restaurant" | "OrderHub"; detail: string }[] = [
  {
    key: "enrolled",
    title: "Join the Apple Developer Program as an organisation",
    who: "Restaurant",
    detail:
      "developer.apple.com/programs/enroll — as a company, not an individual (needs a D-U-N-S number, free from Dun & Bradstreet, takes a few days). £79 a year, paid to Apple.",
  },
  {
    key: "keyReceived",
    title: "Create an App Store Connect API key and send it to us",
    who: "Restaurant",
    detail:
      "App Store Connect → Users and Access → Integrations → App Store Connect API → + . Name it “OrderHub”, access “App Manager”. Download the .p8 file (Apple only lets you download it once) and send it with the Key ID, the Issuer ID and the Team ID (developer.apple.com → Membership).",
  },
  {
    key: "appRecordCreated",
    title: "Create the app in App Store Connect",
    who: "OrderHub",
    detail:
      "Apps → + → New App, iOS, the restaurant's name, bundle ID com.orderhubsolutions.<app>. Apple's API can't create apps, so this is one manual step (we can do it if they add us as a user).",
  },
  {
    key: "built",
    title: "Build the app on their team",
    who: "OrderHub",
    detail:
      "Put the .p8 in apps/customer/secrets/asc/<app>/AuthKey.p8 with key.json {keyId, issuerId}, the Team ID in brands/<app>.json → ios.appleTeamId, then npm run brand -- build <app> ios. EAS makes the certificate, profile and push key on their team.",
  },
  {
    key: "submitted",
    title: "Upload to TestFlight, then submit for review",
    who: "OrderHub",
    detail:
      "npm run brand -- submit <app> ios. Test on TestFlight first; then add screenshots, privacy details and the privacy policy link in App Store Connect and submit.",
  },
  {
    key: "live",
    title: "Live on the App Store",
    who: "OrderHub",
    detail: "Add the App Store ID under Store & promotion and switch promotion on, so customers are sent to it.",
  },
];

const EMPTY_ONBOARDING: IosOnboarding = {
  contactEmail: null,
  teamId: null,
  keyId: null,
  issuerId: null,
  steps: { enrolled: false, keyReceived: false, appRecordCreated: false, built: false, submitted: false, live: false },
  notes: null,
};

function iosBundle(row: SocialLoginAdminRow): string {
  return row.appIds.find((a) => a.startsWith("com.orderhubsolutions.")) ?? "com.orderhubsolutions.<your app>";
}

/** The email/WhatsApp text we send a restaurant to start their iPhone app. */
function clientInstructions(row: SocialLoginAdminRow): string {
  return [
    `Hi,`,
    ``,
    `To publish the ${row.brandName} app on the App Store under your own name, Apple needs it to be on your own developer account. Here's what we need from you:`,
    ``,
    `1. Join the Apple Developer Program as an organisation:`,
    `   https://developer.apple.com/programs/enroll/`,
    `   You'll need a D-U-N-S number for your company (free, from Dun & Bradstreet: https://developer.apple.com/support/D-U-N-S/). The membership is £79 a year, paid to Apple.`,
    ``,
    `2. When your membership is active, create an API key for us:`,
    `   App Store Connect (https://appstoreconnect.apple.com) → Users and Access → Integrations → App Store Connect API → the + button.`,
    `   Name: OrderHub. Access: App Manager.`,
    `   Download the key file (.p8) — Apple only lets you download it once.`,
    ``,
    `3. Send us, securely:`,
    `   • the .p8 key file`,
    `   • the Key ID (shown next to the key)`,
    `   • the Issuer ID (shown at the top of the same page)`,
    `   • your Team ID (developer.apple.com → Account → Membership details)`,
    ``,
    `We'll do the rest: create the app (${iosBundle(row)}), build it, put it on TestFlight for you to try, and submit it to Apple for review.`,
    ``,
    `Thanks!`,
  ].join("\n");
}

export function RestaurantAppsPanel() {
  const [rows, setRows] = useState<SocialLoginAdminRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyApps, setOnlyApps] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(true);

  const load = useCallback(async () => {
    try {
      setRows(await socialLoginClient.list());
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e, "Couldn't load the brands"));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const replace = (row: SocialLoginAdminRow) =>
    setRows((rs) => (rs ? rs.map((r) => (r.brandId === row.brandId ? row : r)) : rs));

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((r) => {
      const hasApp =
        r.appIds.length > 0 || r.store.promote || r.store.androidPackage || r.store.iosAppStoreId || Object.values(r.iosOnboarding.steps).some(Boolean);
      if (onlyApps && !hasApp && !q) return false;
      return !q || r.brandName.toLowerCase().includes(q) || r.tenantName.toLowerCase().includes(q);
    });
  }, [rows, query, onlyApps]);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-1 pb-16">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">Restaurant apps</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Store links and promotion for each restaurant&rsquo;s own app, and getting its iPhone app live on the
          restaurant&rsquo;s Apple account.
        </p>
      </div>

      <section className="rounded-2xl border border-zinc-200 bg-white">
        <button
          type="button"
          onClick={() => setGuideOpen((v) => !v)}
          aria-expanded={guideOpen}
          className="flex w-full items-center gap-3 px-5 py-4 text-left"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-zinc-900 text-white">
            <Apple className="h-5 w-5" aria-hidden />
          </span>
          <span className="flex-1">
            <span className="block font-semibold text-zinc-900">How a restaurant gets its iPhone app</span>
            <span className="block text-sm text-zinc-500">
              Apple requires each restaurant&rsquo;s app on its own developer account. Six steps, two of them theirs.
            </span>
          </span>
          <ChevronDown className={`h-5 w-5 text-zinc-400 transition-transform ${guideOpen ? "rotate-180" : ""}`} aria-hidden />
        </button>
        {guideOpen ? (
          <ol className="grid gap-3 border-t border-zinc-100 p-5 sm:grid-cols-2">
            {STEPS.map((s, i) => (
              <li key={s.key} className="flex gap-3 rounded-xl border border-zinc-200 p-4">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-bold text-white">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-zinc-900">{s.title}</p>
                  <span
                    className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      s.who === "Restaurant" ? "bg-amber-100 text-amber-800" : "bg-sky-100 text-sky-800"
                    }`}
                  >
                    {s.who}
                  </span>
                  <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">{s.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search brands"
            aria-label="Search brands"
            className="w-full rounded-xl border border-zinc-300 py-2 pl-9 pr-3 text-sm focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-200"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={onlyApps}
            onChange={(e) => setOnlyApps(e.target.checked)}
            className="h-4 w-4 rounded border-zinc-300"
          />
          Only brands with an app
        </label>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {!rows && !error ? (
        <div className="flex justify-center py-16 text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" />
        </div>
      ) : null}

      <ul className="space-y-3">
        {visible.map((r) => (
          <BrandRow
            key={r.brandId}
            row={r}
            open={open === r.brandId}
            onToggle={() => setOpen((o) => (o === r.brandId ? null : r.brandId))}
            onSaved={replace}
          />
        ))}
        {rows && !visible.length ? (
          <li className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500">
            No brands match. Untick &ldquo;Only brands with an app&rdquo; to see every brand.
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function BrandRow({
  row,
  open,
  onToggle,
  onSaved,
}: {
  row: SocialLoginAdminRow;
  open: boolean;
  onToggle: () => void;
  onSaved: (r: SocialLoginAdminRow) => void;
}) {
  const done = Object.values(row.iosOnboarding.steps).filter(Boolean).length;
  return (
    <li className="rounded-2xl border border-zinc-200 bg-white">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        {row.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={row.logoUrl} alt="" className="h-10 w-10 shrink-0 rounded-xl border border-zinc-200 object-contain" />
        ) : (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-zinc-400">
            <ImageOff className="h-4 w-4" aria-hidden />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-zinc-900">{row.brandName}</span>
          <span className="block truncate text-xs text-zinc-500">
            {row.tenantName}
            {row.appIds.length ? ` · ${row.appIds.join(", ")}` : ""}
          </span>
        </span>
        <span className="hidden items-center gap-2 sm:flex">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              row.store.promote ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-500"
            }`}
          >
            <Megaphone className="h-3 w-3" aria-hidden /> {row.store.promote ? "Promoted" : "Not promoted"}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold text-zinc-700">
            <Apple className="h-3 w-3" aria-hidden /> {row.iosOnboarding.steps.live ? "Live" : `${done}/6`}
          </span>
        </span>
        <ChevronDown className={`h-5 w-5 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open ? (
        <div className="grid gap-4 border-t border-zinc-100 p-4 lg:grid-cols-2">
          <StoreForm row={row} onSaved={onSaved} />
          <OnboardingForm row={row} onSaved={onSaved} />
        </div>
      ) : null}
    </li>
  );
}

const input =
  "mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-200";

function StoreForm({ row, onSaved }: { row: SocialLoginAdminRow; onSaved: (r: SocialLoginAdminRow) => void }) {
  const androidGuess = row.appIds.find((a) => a.startsWith("com.")) ?? "";
  const [form, setForm] = useState<CustomerAppStore>({
    promote: row.store.promote,
    androidPackage: row.store.androidPackage ?? androidGuess,
    iosAppStoreId: row.store.iosAppStoreId,
    shopIds: row.store.shopIds ?? [],
  });
  const [saving, setSaving] = useState(false);
  const [shops, setShops] = useState<BrandShopOption[] | null>(null);

  useEffect(() => {
    socialLoginClient
      .shops(row.brandId)
      .then(setShops)
      .catch(() => setShops([]));
  }, [row.brandId]);

  const toggleShop = (id: string, on: boolean) =>
    setForm((f) => ({ ...f, shopIds: on ? [...new Set([...f.shopIds, id])] : f.shopIds.filter((x) => x !== id) }));

  const save = async () => {
    setSaving(true);
    try {
      onSaved(
        await socialLoginClient.setStore(row.brandId, {
          promote: form.promote,
          androidPackage: form.androidPackage?.trim() || null,
          iosAppStoreId: form.iosAppStoreId?.trim() || null,
          shopIds: form.shopIds,
        }),
      );
      toast.success("Saved");
    } catch (e) {
      toast.error(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-200 p-4">
      <h3 className="flex items-center gap-2 font-semibold text-zinc-900">
        <Smartphone className="h-4 w-4" aria-hidden /> Store &amp; promotion
      </h3>
      <p className="mt-1 text-xs text-zinc-500">
        When on, phones visiting the storefront get a &ldquo;Get the app&rdquo; banner (Apple&rsquo;s own banner on
        iPhone Safari) and confirmation emails show store buttons. Only switch on once the app is publicly
        downloadable.
      </p>
      <label className="mt-3 block text-sm font-medium text-zinc-800">
        Android package
        <input
          value={form.androidPackage ?? ""}
          onChange={(e) => setForm({ ...form, androidPackage: e.target.value })}
          placeholder="com.orderhubsolutions.pizzauno"
          className={input}
        />
      </label>
      <label className="mt-3 block text-sm font-medium text-zinc-800">
        App Store ID
        <input
          value={form.iosAppStoreId ?? ""}
          onChange={(e) => setForm({ ...form, iosAppStoreId: e.target.value })}
          placeholder="6824555180 (the number in the App Store link)"
          inputMode="numeric"
          className={input}
        />
      </label>
      <fieldset className="mt-4">
        <legend className="flex items-center gap-1.5 text-sm font-medium text-zinc-800">
          <MapPin className="h-3.5 w-3.5" aria-hidden /> Shops in this app
        </legend>
        <p className="mt-0.5 text-xs text-zinc-500">
          A multi-shop app lists these shops, nearest first, and orders placed for one land on that shop&rsquo;s
          order board under this brand. Needs <code className="rounded bg-zinc-100 px-1">&quot;multiShop&quot;: true</code>{" "}
          in the app&rsquo;s brand file.
        </p>
        {!shops ? (
          <Loader2 className="mt-2 h-4 w-4 animate-spin text-zinc-400" aria-label="Loading shops" />
        ) : (
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-zinc-200 p-2">
            {shops.map((shop) => (
              <li key={shop.id}>
                <label className={`flex items-center gap-2 text-sm ${shop.isActive ? "text-zinc-800" : "text-zinc-400"}`}>
                  <input
                    type="checkbox"
                    checked={shop.fixed || form.shopIds.includes(shop.id)}
                    disabled={shop.fixed}
                    onChange={(e) => toggleShop(shop.id, e.target.checked)}
                    className="h-4 w-4 rounded border-zinc-300"
                  />
                  <span className="truncate">
                    {shop.name}
                    {shop.postcode ? <span className="text-zinc-400"> · {shop.postcode}</span> : null}
                  </span>
                  {shop.fixed ? <span className="ml-auto shrink-0 text-[11px] text-zinc-400">main shop</span> : null}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <label className="mt-3 flex items-center gap-2 text-sm font-medium text-zinc-800">
        <input
          type="checkbox"
          checked={form.promote}
          onChange={(e) => setForm({ ...form, promote: e.target.checked })}
          className="h-4 w-4 rounded border-zinc-300"
        />
        Promote the app to customers
      </label>
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Save
      </button>
    </div>
  );
}

function OnboardingForm({ row, onSaved }: { row: SocialLoginAdminRow; onSaved: (r: SocialLoginAdminRow) => void }) {
  const [form, setForm] = useState<IosOnboarding>({ ...EMPTY_ONBOARDING, ...row.iosOnboarding });
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<IosOnboarding>) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    setSaving(true);
    try {
      onSaved(await socialLoginClient.setIosOnboarding(row.brandId, form));
      toast.success("Saved");
    } catch (e) {
      toast.error(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(clientInstructions(row));
      toast.success("Instructions copied — paste them into an email or WhatsApp");
    } catch {
      toast.error("Couldn't copy — your browser blocked the clipboard");
    }
  };

  return (
    <div className="rounded-xl border border-zinc-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="flex items-center gap-2 font-semibold text-zinc-900">
          <Apple className="h-4 w-4" aria-hidden /> iPhone onboarding
        </h3>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-800 hover:bg-zinc-50"
        >
          <ClipboardCopy className="h-3.5 w-3.5" aria-hidden /> Copy instructions for the client
        </button>
      </div>

      <ul className="mt-3 space-y-1.5">
        {STEPS.map((s, i) => (
          <li key={s.key}>
            <label className="flex items-center gap-2 text-sm text-zinc-800">
              <input
                type="checkbox"
                checked={form.steps[s.key]}
                onChange={(e) => set({ steps: { ...form.steps, [s.key]: e.target.checked } })}
                className="h-4 w-4 rounded border-zinc-300"
              />
              <span className={form.steps[s.key] ? "text-zinc-400 line-through" : ""}>
                {i + 1}. {s.title}
              </span>
              {form.steps[s.key] ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden /> : null}
            </label>
          </li>
        ))}
      </ul>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-zinc-800">
          Client contact email
          <input value={form.contactEmail ?? ""} onChange={(e) => set({ contactEmail: e.target.value })} className={input} />
        </label>
        <label className="block text-sm font-medium text-zinc-800">
          Apple Team ID
          <input
            value={form.teamId ?? ""}
            onChange={(e) => set({ teamId: e.target.value })}
            placeholder="10 characters"
            className={input}
          />
        </label>
        <label className="block text-sm font-medium text-zinc-800">
          API Key ID
          <input value={form.keyId ?? ""} onChange={(e) => set({ keyId: e.target.value })} placeholder="10 characters" className={input} />
        </label>
        <label className="block text-sm font-medium text-zinc-800">
          Issuer ID
          <input
            value={form.issuerId ?? ""}
            onChange={(e) => set({ issuerId: e.target.value })}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            className={input}
          />
        </label>
      </div>
      <label className="mt-3 block text-sm font-medium text-zinc-800">
        Notes
        <textarea value={form.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} rows={2} className={input} />
      </label>
      <p className="mt-2 text-xs text-zinc-500">
        The .p8 key file isn&rsquo;t stored here: it goes to the build machine at apps/customer/secrets/asc/&lt;app&gt;/.
      </p>
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Save
      </button>
    </div>
  );
}
