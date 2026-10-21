"use client";

// Loyalty card settings, per location.
//
// It sits in Marketing because that is where an operator goes to give money
// away, but it is not a campaign and is kept visibly apart from them:
// campaigns are advertised on the storefront and pushed to marketplaces, and
// a stamp card is private to the customer holding it.
//
// Per LOCATION, deliberately — the shop giving the food away is the shop that
// pays for it, and a group running six sites will not want one rule across
// all of them.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Heart, Loader2, Check, X, Search, Wallet, Printer, Copy, QrCode } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { apiClient } from "@/lib/api/client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { useCurrency } from "@/hooks/use-currency";
import { brandsClient } from "@/lib/api/locations.client";
import { StampIcon, WalletCard, readableOn } from "@/components/loyalty/wallet-card";
import { DEFAULT_STAMP_ICON, describeLoyaltyReward, stampIconGroups } from "@orderhub/shared";
import { walkInTill } from "@/lib/api/loyalty-walk-in.client";
import { salonClient } from "@/lib/api/salon.client";

interface Card {
  isActive: boolean;
  stampsRequired: number;
  minimumSpend: number | string | null;
  rewardItemId: string | null;
  rewardLabel: string;
  /** FREE_ITEM (rewardItemId) or PERCENT_OFF (rewardPercent off the order). */
  rewardType: "FREE_ITEM" | "PERCENT_OFF";
  rewardPercent: number | null;
  /** Percent rewards: the most it can take off, and the order it needs. */
  rewardMaxDiscount: number | string | null;
  rewardMinOrder: number | string | null;
  rewardExpiryDays: number | null;
  /** In-store card: Apple/Google Wallet pass scanned at the till. */
  walkInEnabled: boolean;
  cardTitle: string | null;
  cardColor: string | null;
  cardLogoUrl: string | null;
  /** STAMP_ICONS key — the picture on each stamp. */
  stampIcon: string | null;
}

export function LoyaltyCardPanel({
  brandId,
  onClose,
}: {
  brandId?: string | null;
  onClose?: () => void;
}) {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const { symbol } = useCurrency();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<Card>({
    queryKey: ["loyalty-card-config", locationId],
    enabled: !!locationId,
    queryFn: () =>
      apiClient.get(`/v1/loyalty/cards/${locationId}`).then((r) => r.data),
  });

  // The reward comes from the PUBLISHED menu, the same source Top Sellers
  // uses — not the product catalog. The catalog holds everything a tenant has
  // ever created, including items on no menu at all, and offering one of those
  // as a reward is offering something the customer cannot see and the kitchen
  // may not make.
  const { data: brands = [] } = useQuery({
    queryKey: ["brands", locationId],
    queryFn: () => brandsClient.list(locationId ?? undefined),
    enabled: !!locationId,
  });
  const [pickedBrand, setPickedBrand] = useState<string | null>(brandId ?? null);
  const activeBrand = brands.find((b: any) => b.id === pickedBrand) ?? brands[0];

  const { data: storefront } = useQuery({
    queryKey: ["loyalty-reward-menu", locationId, activeBrand?.id],
    enabled: !!locationId && !!activeBrand?.id,
    queryFn: () =>
      apiClient
        .get(
          `/v1/ordering/store/${encodeURIComponent(String(locationId))}` +
            `?brand=${encodeURIComponent(activeBrand!.id)}`,
        )
        .then((r) => r.data as any),
  });

  // A barber / salon has no food menu: its reward is a SERVICE ("Free skin
  // fade"). The card's reward item can only point at a menu item, so the
  // chosen service is kept in the salon's own settings and the card keeps
  // the wording; salon checkout takes that service off when it's spent.
  const { data: salon } = useQuery({
    queryKey: ["salon", "settings", locationId],
    queryFn: () => salonClient.settings(locationId!),
    enabled: !!locationId,
    staleTime: 60_000,
  });
  const isSalon = !!salon?.isSalon;
  const { data: salonServices = [] } = useQuery({
    queryKey: ["salon", "services", locationId],
    queryFn: () => salonClient.services(locationId!),
    enabled: !!locationId && isSalon,
  });
  const [rewardServiceId, setRewardServiceId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (salon && rewardServiceId === undefined) setRewardServiceId(salon.settings.loyaltyRewardServiceId ?? null);
  }, [salon, rewardServiceId]);

  const items = useMemo(() => {
    const out: Array<{ id: string; name: string; price: number; imageUrl: string | null; category: string }> = [];
    if (isSalon) {
      for (const sv of salonServices) {
        if (!sv.isActive) continue;
        out.push({ id: sv.id, name: sv.name, price: sv.price, imageUrl: sv.imageUrl, category: sv.category });
      }
      return out;
    }
    for (const cat of storefront?.menu?.categories ?? []) {
      for (const link of cat.items ?? []) {
        const it = link?.item;
        if (!it?.id) continue;
        out.push({
          id: it.id,
          name: it.name,
          price: Number(it.basePrice ?? 0),
          imageUrl: it.imageUrl ?? null,
          category: cat.name ?? "",
        });
      }
    }
    return out;
  }, [storefront, isSalon, salonServices]);

  const [itemSearch, setItemSearch] = useState("");
  const shown = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q),
    );
  }, [items, itemSearch]);

  const [form, setForm] = useState<Card | null>(null);
  useEffect(() => {
    if (data && !form)
      setForm({
        ...data,
        minimumSpend: data.minimumSpend ?? null,
        rewardType: data.rewardType === "PERCENT_OFF" ? "PERCENT_OFF" : "FREE_ITEM",
        rewardPercent: data.rewardPercent ?? null,
        rewardMaxDiscount: data.rewardMaxDiscount != null ? Number(data.rewardMaxDiscount) : null,
        rewardMinOrder: data.rewardMinOrder != null ? Number(data.rewardMinOrder) : null,
        walkInEnabled: data.walkInEnabled ?? false,
        cardTitle: data.cardTitle ?? null,
        cardColor: data.cardColor ?? null,
        cardLogoUrl: data.cardLogoUrl ?? null,
        stampIcon: data.stampIcon ?? null,
      });
  }, [data, form]);

  const save = useMutation({
    mutationFn: async (body: Card) => {
      if (isSalon) {
        await salonClient.saveSettings(locationId!, { loyaltyRewardServiceId: rewardServiceId ?? null });
        void qc.invalidateQueries({ queryKey: ["salon", "settings", locationId] });
      }
      return apiClient
        .put(
          `/v1/loyalty/cards/${locationId}`,
          isSalon || body.rewardType === "PERCENT_OFF" ? { ...body, rewardItemId: null } : body,
        )
        .then((r) => r.data);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["loyalty-card-config", locationId] });
      // Close on save so the operator lands back on the campaigns list, the
      // same way the campaign form behaves.
      onClose?.();
    },
  });

  if (!locationId) {
    return (
      <Shell>
        <p className="text-sm text-zinc-500">
          Pick a location — a loyalty card belongs to one shop, not the whole
          group.
        </p>
      </Shell>
    );
  }
  if (isLoading || !form) {
    return (
      <Shell>
        <Loader2 className="h-5 w-5 animate-spin text-zinc-300" />
      </Shell>
    );
  }

  const set = <K extends keyof Card>(k: K, v: Card[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const percentMode = form.rewardType === "PERCENT_OFF";
  const noReward = percentMode
    ? !(Number(form.rewardPercent) >= 1 && Number(form.rewardPercent) <= 100)
    : !form.rewardItemId && !form.rewardLabel.trim();
  const money = (n: number) => `${symbol}${Number.isInteger(n) ? n : n.toFixed(2)}`;
  // Percent rewards: the card wording follows the numbers, so what the
  // customer reads always matches what the till takes off.
  const setPercentTerms = (patch: Partial<Pick<Card, "rewardPercent" | "rewardMaxDiscount" | "rewardMinOrder">>) =>
    setForm((f) => {
      if (!f) return f;
      const next = { ...f, ...patch };
      const pct = Number(next.rewardPercent);
      return {
        ...next,
        rewardLabel:
          pct >= 1 && pct <= 100
            ? describeLoyaltyReward(
                { percentOff: pct, maxDiscount: next.rewardMaxDiscount, minOrder: next.rewardMinOrder },
                money,
              )
            : next.rewardLabel,
      };
    });
  const chosenId = isSalon ? rewardServiceId : form.rewardItemId;

  return (
    <Shell>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <Heart className="h-4 w-4" /> Loyalty card
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Customers collect a stamp per order and claim a reward when the
            card is full. It shows only on their own card in the app — never on
            your public menu.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-medium text-zinc-700">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => set("isActive", e.target.checked)}
            className="h-4 w-4 rounded border-zinc-300"
          />
          Live
        </label>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Stamps needed" hint="Six is what most people expect.">
          <input
            type="number"
            min={2}
            max={20}
            value={form.stampsRequired}
            onChange={(e) => set("stampsRequired", Number(e.target.value))}
            className={input}
          />
        </Field>

        <Field
          label="Minimum spend per stamp"
          hint="Leave empty and any order earns one — including a bag of chips."
        >
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400">
              {symbol}
            </span>
            <input
              type="number"
              min={0}
              step="0.5"
              placeholder="Any order"
              value={form.minimumSpend ?? ""}
              onChange={(e) =>
                set("minimumSpend", e.target.value === "" ? null : Number(e.target.value))
              }
              className={`${input} pl-7`}
            />
          </div>
        </Field>

        <Field
          label="Reward"
          hint={
            isSalon
              ? "The service they get free when the card is full. Taken off at checkout when you scan their card."
              : percentMode
                ? "What they get when the card is full: a percentage off their next order."
                : "What staff hand over when the card is full. Picked from the live menu, so it is something they actually make."
          }
        >
          <div role="radiogroup" aria-label="Reward type" className="mb-2 grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1">
            {(
              [
                ["FREE_ITEM", isSalon ? "Free service" : "Free item"],
                ["PERCENT_OFF", "% off the order"],
              ] as const
            ).map(([value, text]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={form.rewardType === value}
                onClick={() => {
                  if (value === form.rewardType) return;
                  if (value === "PERCENT_OFF") {
                    set("rewardType", "PERCENT_OFF");
                    setPercentTerms({ rewardPercent: form.rewardPercent ?? 10 });
                  } else {
                    setForm((f) => (f ? { ...f, rewardType: "FREE_ITEM", rewardLabel: "" } : f));
                  }
                }}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                  form.rewardType === value ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-600 hover:text-zinc-900"
                }`}
              >
                {text}
              </button>
            ))}
          </div>
          {percentMode ? (
            <div className="space-y-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-zinc-600">Percentage off the whole order</span>
                <div className="relative">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={form.rewardPercent ?? ""}
                    onChange={(e) =>
                      setPercentTerms({ rewardPercent: e.target.value === "" ? null : Math.round(Number(e.target.value)) })
                    }
                    className={`${input} pr-8`}
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400">%</span>
                </div>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-zinc-600">Only on orders of at least</span>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400">{symbol}</span>
                    <input
                      type="number"
                      min={0}
                      step="0.5"
                      placeholder="Any order"
                      value={form.rewardMinOrder ?? ""}
                      onChange={(e) =>
                        setPercentTerms({ rewardMinOrder: e.target.value === "" ? null : Number(e.target.value) })
                      }
                      className={`${input} pl-7`}
                    />
                  </div>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-zinc-600">Most it can take off</span>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400">{symbol}</span>
                    <input
                      type="number"
                      min={0}
                      step="0.5"
                      placeholder="No limit"
                      value={form.rewardMaxDiscount ?? ""}
                      onChange={(e) =>
                        setPercentTerms({ rewardMaxDiscount: e.target.value === "" ? null : Number(e.target.value) })
                      }
                      className={`${input} pl-7`}
                    />
                  </div>
                </label>
              </div>
              <p className="text-[11px] text-zinc-500">
                Comes off the order when they use it — online, at the till or at checkout. If the order is under the
                minimum, the reward stays on their card for next time.
              </p>
            </div>
          ) : (
          <>
          {!isSalon && brands.length > 1 && (
            <select
              value={activeBrand?.id ?? ""}
              onChange={(e) => setPickedBrand(e.target.value)}
              className={`${input} mb-2`}
            >
              {brands.map((b: any) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              value={itemSearch}
              onChange={(e) => setItemSearch(e.target.value)}
              placeholder={isSalon ? "Search your services…" : "Search the menu…"}
              className={`${input} pl-8`}
            />
          </div>
          {/* A scrolling list rather than a dropdown: a kebab shop's menu runs
              to a couple of hundred items, and a native select of that length
              is unusable on a laptop and worse on a tablet. */}
          <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-zinc-200">
            {items.length === 0 ? (
              <p className="p-3 text-xs text-zinc-400">
                {isSalon
                  ? "No services yet — add them under Appointments → Services."
                  : "No published menu for this brand yet — publish one and its items appear here."}
              </p>
            ) : shown.length === 0 ? (
              <p className="p-3 text-xs text-zinc-400">
                Nothing matches &ldquo;{itemSearch}&rdquo;.
              </p>
            ) : (
              shown.map((i) => {
                const on = chosenId === i.id;
                return (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => {
                      if (isSalon) setRewardServiceId(on ? null : i.id);
                      else set("rewardItemId", on ? null : i.id);
                      // Keep the wording in step with the item, so the
                      // customer's card and the kitchen ticket agree.
                      if (!on) set("rewardLabel", `Free ${i.name}`);
                    }}
                    className={`flex w-full items-center gap-2.5 border-b border-zinc-100 px-3 py-2 text-left last:border-b-0 ${
                      on ? "bg-rose-50" : "hover:bg-zinc-50"
                    }`}
                  >
                    {i.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={i.imageUrl}
                        alt=""
                        className="h-8 w-8 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <span className="h-8 w-8 shrink-0 rounded bg-zinc-100" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-zinc-900">
                        {i.name}
                      </span>
                      <span className="block truncate text-[11px] text-zinc-400">
                        {i.category} · {symbol}
                        {i.price.toFixed(2)}
                      </span>
                    </span>
                    {on && <Check className="h-4 w-4 shrink-0 text-rose-600" />}
                  </button>
                );
              })
            )}
          </div>
          </>
          )}
        </Field>

        <Field
          label="Reward expires after"
          hint="Days. Leave empty and it never expires."
        >
          <input
            type="number"
            min={1}
            placeholder="Never"
            value={form.rewardExpiryDays ?? ""}
            onChange={(e) =>
              set("rewardExpiryDays", e.target.value === "" ? null : Number(e.target.value))
            }
            className={input}
          />
        </Field>
      </div>

      <Field
        label="How it reads on their card"
        hint="Frozen onto a reward the moment it is earned, so changing this never rewrites a promise you already made."
      >
        <input
          value={form.rewardLabel}
          onChange={(e) => set("rewardLabel", e.target.value)}
          placeholder="Free regular chips"
          className={input}
        />
      </Field>

      <WalkInSection
        form={form}
        set={set}
        locationId={locationId}
        rewardFallback={percentMode ? undefined : items.find((i) => i.id === chosenId)?.name}
      />

      {form.isActive && noReward && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          Choose a reward before going live, or every customer&apos;s card
          carries an empty promise.
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          disabled={save.isPending || (form.isActive && noReward)}
          onClick={() => save.mutate(form)}
          className="inline-flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-40"
        >
          {save.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : save.isSuccess ? (
            <Check className="h-4 w-4" />
          ) : null}
          Save card
        </button>
        {save.isError && (
          <span className="text-xs text-red-600">
            {(save.error as any)?.response?.data?.message ?? "Could not save."}
          </span>
        )}
      </div>
    </Shell>
  );
}

// Card colours that print and read well on a phone. Custom via the picker.
const SWATCHES = ["#1F2937", "#6B3E26", "#14532D", "#7F1D1D", "#1E3A8A", "#581C87", "#B45309", "#F5F0E6"];

function WalkInSection({
  form,
  set,
  locationId,
  rewardFallback,
}: {
  form: Card;
  set: <K extends keyof Card>(k: K, v: Card[K]) => void;
  locationId: string;
  rewardFallback?: string;
}) {
  const { data: overview } = useQuery({
    queryKey: ["loyalty-walk-in-overview", locationId],
    queryFn: () => walkInTill.overview(locationId),
  });
  const shopName = overview?.defaultTitle ?? "";
  const [copied, setCopied] = useState(false);
  const color = form.cardColor ?? "#1F2937";
  const title = form.cardTitle?.trim() || shopName || "Your shop";
  const reward = form.rewardLabel.trim() || (rewardFallback ? `Free ${rewardFallback}` : "Free item");

  const posterHref = overview
    ? `/print/loyalty-poster?${new URLSearchParams({
        u: overview.joinUrl,
        t: title,
        r: reward,
        n: String(form.stampsRequired),
        c: color.replace("#", ""),
        i: form.stampIcon ?? DEFAULT_STAMP_ICON,
      }).toString()}`
    : null;

  return (
    <div className="mt-6 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <Wallet className="h-4 w-4" /> In-store card · Apple &amp; Google Wallet
          </h3>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-zinc-500">
            For walk-in customers who never order online. They scan the poster on your counter, add the card
            to their phone&apos;s wallet, and you scan it at the till — stamps and rewards are the same as above.
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm font-medium text-zinc-700">
          <input
            type="checkbox"
            checked={form.walkInEnabled}
            onChange={(e) => set("walkInEnabled", e.target.checked)}
            className="h-4 w-4 rounded border-zinc-300"
          />
          On
        </label>
      </div>

      {form.walkInEnabled && !form.isActive && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          Switch the loyalty card <strong>Live</strong> (top right) too — the in-store card uses the same stamps
          and reward.
        </p>
      )}

      <div className="mt-4 grid gap-5 md:grid-cols-[1fr_280px]">
        <div>
          <Field label="Name on the card" hint="Defaults to the shop name.">
            <input
              value={form.cardTitle ?? ""}
              onChange={(e) => set("cardTitle", e.target.value || null)}
              placeholder={shopName || "Shop name"}
              maxLength={40}
              className={input}
            />
          </Field>
          <Field label="Card colour">
            <div className="flex flex-wrap items-center gap-2">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set("cardColor", c)}
                  aria-label={`Colour ${c}`}
                  aria-pressed={color.toUpperCase() === c}
                  className={`h-8 w-8 rounded-full border transition ${
                    color.toUpperCase() === c ? "ring-2 ring-zinc-900 ring-offset-2" : "border-zinc-300"
                  }`}
                  style={{ background: c }}
                />
              ))}
              <label className="relative h-8 w-8 cursor-pointer overflow-hidden rounded-full border border-dashed border-zinc-400" title="Custom colour">
                <input
                  type="color"
                  value={color}
                  onChange={(e) => set("cardColor", e.target.value.toUpperCase())}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  aria-label="Custom colour"
                />
                <span className="flex h-full w-full items-center justify-center text-xs text-zinc-500">+</span>
              </label>
            </div>
          </Field>
          <Field label="Stamp icon" hint="The picture on each stamp — pick one that fits the business.">
            <StampIconPicker
              value={form.stampIcon ?? DEFAULT_STAMP_ICON}
              color={color}
              onChange={(k) => set("stampIcon", k)}
            />
          </Field>
          <Field label="Logo image URL" hint="Square works best. Leave empty to use the shop's logo.">
            <input
              value={form.cardLogoUrl ?? ""}
              onChange={(e) => set("cardLogoUrl", e.target.value || null)}
              placeholder="https://…"
              className={input}
            />
          </Field>

          {overview && (
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Members" value={overview.members} />
              <Stat label="Joined this week" value={overview.joinedThisWeek} />
              <Stat label="Stamps (30 days)" value={overview.stampsThisMonth} />
              <Stat label="Rewards claimed" value={overview.rewardsClaimed} />
            </div>
          )}

          {overview && (
            <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px]">
              <Ready on={overview.walletReady.apple} label="Apple Wallet" />
              <Ready on={overview.walletReady.google} label="Google Wallet" />
              <Ready on={overview.walletReady.email} label="Email card links" />
            </div>
          )}
          {overview && (!overview.walletReady.apple || !overview.walletReady.google) && (
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              Until a wallet is connected, customers keep the card as a web page with the same QR — the till
              scans it just the same.
            </p>
          )}
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold text-zinc-700">Preview</p>
          <WalletCard
            title={title}
            color={color}
            stampIcon={form.stampIcon}
            logoUrl={form.cardLogoUrl || overview?.defaultLogoUrl}
            stamps={Math.min(2, form.stampsRequired - 1)}
            stampsRequired={form.stampsRequired}
            rewardLabel={reward}
          />
          {overview && form.walkInEnabled && (
            <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700">
                <QrCode className="h-3.5 w-3.5" /> Join link for your counter
              </p>
              <div className="mt-2 flex items-center gap-3">
                <QRCodeSVG value={overview.joinUrl} size={72} marginSize={0} />
                <div className="min-w-0 space-y-1.5">
                  {posterHref && (
                    <a
                      href={posterHref}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1.5 text-xs font-semibold text-zinc-900 hover:underline"
                    >
                      <Printer className="h-3.5 w-3.5" /> Print counter poster
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(overview.joinUrl).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      });
                    }}
                    className="flex items-center gap-1.5 text-xs text-zinc-600 hover:text-zinc-900"
                  >
                    <Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy link"}
                  </button>
                </div>
              </div>
              <p className="mt-2 text-[11px] text-zinc-400">Save the card first so the poster shows your latest design.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StampIconPicker({
  value,
  color,
  onChange,
}: {
  value: string;
  color: string;
  onChange: (key: string) => void;
}) {
  const groups = useMemo(() => stampIconGroups(), []);
  return (
    <div className="max-h-64 space-y-3 overflow-y-auto rounded-md border border-zinc-200 bg-white p-3">
      {groups.map((g) => (
        <div key={g.group}>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{g.group}</p>
          <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8" role="radiogroup" aria-label={g.group}>
            {g.icons.map((ic) => {
              const on = value === ic.key;
              return (
                <button
                  key={ic.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={ic.label}
                  title={ic.label}
                  onClick={() => onChange(ic.key)}
                  className={`flex aspect-square items-center justify-center rounded-lg border transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900 ${
                    on ? "border-transparent shadow-sm" : "border-zinc-200 text-zinc-600 hover:border-zinc-400"
                  }`}
                  style={on ? { background: color, color: readableOn(color) } : undefined}
                >
                  <StampIcon icon={ic.key} className="h-5 w-5" />
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
      <p className="text-lg font-semibold tabular-nums text-zinc-900">{value}</p>
      <p className="text-[11px] text-zinc-500">{label}</p>
    </div>
  );
}

function Ready({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${
        on ? "bg-emerald-50 text-emerald-700" : "bg-zinc-100 text-zinc-500"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-emerald-500" : "bg-zinc-400"}`} />
      {label} {on ? "connected" : "not set up"}
    </span>
  );
}

const input =
  "w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">{children}</div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3">
      <label className="block text-xs font-semibold text-zinc-700">{label}</label>
      {hint && <p className="mb-1 mt-0.5 text-[11px] text-zinc-400">{hint}</p>}
      {children}
    </div>
  );
}
