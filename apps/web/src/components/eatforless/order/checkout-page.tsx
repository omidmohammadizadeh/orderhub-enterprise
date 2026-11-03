"use client";

// Checkout on the website: delivery or collection, the address, when, the
// order, a tip, totals, then payment. The same rules as the app: signed in,
// mobile confirmed, and the server re-prices everything (these totals are
// the preview).

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2, MapPin, ShoppingBag } from "lucide-react";
import { eflPublicClient } from "@/lib/api/efl.client";
import { eflCustomerApi, EflApiError, type EflCheckoutBody, type EflCheckoutResult } from "@/lib/api/efl-customer";
import { useEflHref } from "../efl-base-context";
import { EflWordmark } from "../efl-logo";
import { FOCUS } from "../efl-styles";
import { money } from "../feed/shop-card";
import { geocodePostcode, normalisePostcode } from "../postcode";
import { basketSubtotal, useBasket } from "./basket";
import { lineDetail, useBasketReady } from "./basket-drawer";
import { EflPayment } from "./efl-payment";
import { Stepper } from "./item-dialog";
import { PhoneCheck } from "./phone-check";
import { customerName, useEflSession, useHydrateEflSession } from "./session";
import { SignInDialog } from "./sign-in-dialog";

type Mode = "DELIVERY" | "PICKUP";
type Address = { line1: string; line2: string; city: string; postcode: string; instructions: string };
type Point = { lat: number; lng: number; postcode: string };

const ADDRESS_KEY = "efl.address";
const TIPS = [0, 1, 2, 3];
const round2 = (n: number) => Math.round(n * 100) / 100;

function readAddress(): Address {
  const empty = { line1: "", line2: "", city: "", postcode: "", instructions: "" };
  try {
    const raw = window.localStorage.getItem(ADDRESS_KEY);
    return raw ? { ...empty, ...(JSON.parse(raw) as Partial<Address>) } : empty;
  } catch {
    return empty;
  }
}

function saveAddress(a: Address): void {
  try {
    window.localStorage.setItem(ADDRESS_KEY, JSON.stringify(a));
  } catch {
    // Not saved for next time; this order is unaffected.
  }
}

/** The next slots: every 15 minutes, from 45 minutes out, for 4 hours. */
function slots(): Date[] {
  const start = new Date(Date.now() + 45 * 60_000);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
  return Array.from({ length: 16 }, (_, i) => new Date(start.getTime() + i * 15 * 60_000));
}
const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

const card = "rounded-2xl border border-[#E2E2E2] p-5";
const h2 = "m-0 text-lg font-extrabold tracking-[-0.01em]";
const input = `min-h-[48px] w-full rounded-xl border border-[#D6D6D6] px-4 text-base ${FOCUS}`;

export function CheckoutPage() {
  useHydrateEflSession();
  useBasketReady();
  const href = useEflHref();
  const router = useRouter();
  const session = useEflSession();
  const { shop, lines, setQuantity, clear } = useBasket();

  const menuQ = useQuery({
    queryKey: ["efl-menu", shop?.id],
    queryFn: () => eflPublicClient.menu(shop!.id),
    enabled: !!shop,
    staleTime: 60_000,
  });
  const listing = menuQ.data?.listing;
  const canDeliver = listing?.acceptsDelivery ?? true;
  const canCollect = listing?.acceptsCollection ?? true;
  const [mode, setMode] = useState<Mode>("DELIVERY");
  useEffect(() => {
    if (listing && !listing.acceptsDelivery && listing.acceptsCollection) setMode("PICKUP");
  }, [listing]);
  const delivery = mode === "DELIVERY";

  const [address, setAddress] = useState<Address>({ line1: "", line2: "", city: "", postcode: "", instructions: "" });
  useEffect(() => setAddress(readAddress()), []);
  const postcode = normalisePostcode(address.postcode);
  const fullPostcode = postcode && postcode.includes(" ") ? postcode : null;

  const pointQ = useQuery({
    queryKey: ["efl-geocode", fullPostcode],
    queryFn: async ({ signal }): Promise<Point | null> => {
      const r = await geocodePostcode(fullPostcode!, signal);
      return r.ok ? { lat: r.lat, lng: r.lng, postcode: r.postcode } : null;
    },
    enabled: delivery && !!fullPostcode,
    staleTime: Infinity,
  });
  const point = pointQ.data ?? null;

  // Delivery fee, minimum and ETA for THIS address: the feed's numbers.
  const shopsQ = useQuery({
    queryKey: ["efl-shops", point?.lat, point?.lng, point?.postcode ?? null],
    queryFn: () => eflPublicClient.shops({ lat: point!.lat, lng: point!.lng, postcode: point!.postcode }),
    enabled: delivery && !!point,
    staleTime: 60_000,
  });
  const here = shopsQ.data?.find((s) => s.id === shop?.id) ?? null;
  const deliversHere = !delivery || (here ? here.delivery.available : false);

  const [when, setWhen] = useState<"now" | Date>("now");
  const slotList = useMemo(slots, []);
  const [tip, setTip] = useState(1);
  const [signInOpen, setSignInOpen] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<{ result: EflCheckoutResult; key: string } | null>(null);
  const idempotency = useRef<{ key: string; sig: string } | null>(null);

  const subtotal = basketSubtotal(lines);
  const deliveryFee = delivery ? here?.delivery.fee ?? 0 : 0;
  const tipAmount = delivery ? TIPS[tip]! : 0;
  const total = round2(subtotal + deliveryFee + tipAmount);
  const minimum = Number((delivery ? here?.delivery.minOrder : null) ?? menuQ.data?.store.directConfig?.minOrderForDelivery ?? 0);
  const underMinimum = delivery && minimum > 0 && subtotal < minimum;
  const prep = menuQ.data?.store.directConfig?.[delivery ? "deliveryPrepMinutes" : "collectionPrepMinutes"] ?? (delivery ? 30 : 15);
  const eta = delivery ? here?.delivery.etaMinutes ?? { min: prep, max: prep + 10 } : { min: prep, max: prep + 5 };
  const addressReady = !delivery || (address.line1.trim() && address.city.trim() && fullPostcode && point);

  if (!shop || lines.length === 0) {
    return (
      <Shell>
        <div className="mx-auto flex max-w-[480px] flex-col items-center gap-3 px-4 py-24 text-center">
          <ShoppingBag aria-hidden="true" className="h-12 w-12 text-[#B5B5B5]" />
          <h1 className="m-0 text-[28px] font-extrabold tracking-[-0.02em]">Your basket is empty</h1>
          <p className="m-0 text-[#5E5E5E]">Add something tasty from a shop near you.</p>
          <Link
            href={href("/")}
            className={`efl-press mt-2 inline-flex min-h-[48px] items-center rounded-full bg-[#0B0B0B] px-6 font-bold text-white ${FOCUS}`}
          >
            Find food
          </Link>
        </div>
      </Shell>
    );
  }

  const blocker = (): string | null => {
    if (menuQ.data && !menuQ.data.store.isOpen) return `${shop.name} is closed right now.`;
    if (delivery && !addressReady) return "Add your delivery address.";
    if (delivery && shopsQ.isSuccess && !deliversHere) return `${shop.name} doesn't deliver to ${point?.postcode ?? "this postcode"}. Try collection.`;
    if (underMinimum) return `The minimum for delivery is ${money(minimum)}.`;
    return null;
  };

  const place = async () => {
    setError(null);
    const why = blocker();
    if (why) {
      setError(why);
      return;
    }
    if (session.status !== "signedIn") {
      setSignInOpen(true);
      return;
    }
    if (!session.phoneVerified) {
      setError("Confirm your mobile number first, above.");
      document.getElementById("phone-check")?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (delivery) saveAddress(address);
    const body: EflCheckoutBody = {
      idempotencyKey: "",
      fulfillmentType: mode,
      ...(delivery && point
        ? {
            deliveryAddress: {
              line1: address.line1.trim(),
              line2: [address.line2.trim(), address.instructions.trim()].filter(Boolean).join(" · ") || undefined,
              city: address.city.trim(),
              postcode: point.postcode,
              latitude: point.lat,
              longitude: point.lng,
            },
          }
        : {}),
      items: lines.map((l) => ({
        menuItemId: l.menuItemId,
        name: l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        // The option id and size let the server price each line exactly.
        modifiers: l.modifiers.map((m) => ({
          name: m.name,
          price: m.price,
          optionId: m.id,
          ...(m.depth ? { depth: m.depth } : {}),
          ...(m.path?.length ? { path: m.path } : {}),
          ...(m.parentOptionId ? { parentOptionId: m.parentOptionId } : {}),
        })),
        ...(l.sku ? { skuPlu: l.sku.plu, skuName: l.sku.name } : {}),
        ...(l.notes ? { notes: l.notes } : {}),
      })),
      subtotal,
      deliveryFee,
      tipAmount,
      total,
      ...(when !== "now" ? { scheduledFor: when.toISOString() } : {}),
    };
    // Same basket, same key: paying again after backing out re-uses the
    // order instead of opening a second one.
    const sig = JSON.stringify({ ...body, idempotencyKey: "" });
    if (!idempotency.current || idempotency.current.sig !== sig) {
      idempotency.current = { key: `efl-web-${crypto.randomUUID()}`, sig };
    }
    body.idempotencyKey = idempotency.current.key;

    setPlacing(true);
    try {
      const result = await eflCustomerApi.checkout(shop.id, body);
      const ordersPage = href(`/orders/${encodeURIComponent(result.orderId)}`);
      if (result.clientSecret) {
        const key = result.publishableKey || (await eflCustomerApi.config().then((c) => c.stripePublishableKey).catch(() => null));
        if (!key) throw new EflApiError("Card payments aren't available right now. Please try again in a moment.", 0);
        setPayment({ result, key });
        requestAnimationFrame(() => document.getElementById("pay")?.scrollIntoView({ block: "start", behavior: "smooth" }));
      } else if (result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
      } else {
        // Nothing to pay.
        clear();
        router.push(ordersPage);
      }
    } catch (err) {
      const message = err instanceof EflApiError ? err.message : "Something went wrong. Please try again.";
      if (/confirm your mobile/i.test(message)) void session.refresh();
      setError(message);
    } finally {
      setPlacing(false);
    }
  };

  const paid = () => {
    const orderId = payment!.result.orderId;
    clear();
    idempotency.current = null;
    router.push(href(`/orders/${encodeURIComponent(orderId)}`));
  };

  return (
    <Shell>
      <div className="mx-auto grid max-w-[1100px] gap-6 px-4 pb-24 pt-6 sm:px-5 lg:grid-cols-[1fr_400px] lg:items-start">
        <div className="flex flex-col gap-5">
          <div>
            <h1 className="m-0 text-[32px] font-extrabold leading-tight tracking-[-0.02em]">Checkout</h1>
            <p className="m-0 text-[15px] text-[#5E5E5E]">
              {shop.name}
              {shop.area ? ` · ${shop.area}` : ""}
            </p>
          </div>

          <div role="group" aria-label="Delivery or collection" className="flex rounded-full bg-[#F3F3F3] p-1">
            {(["DELIVERY", "PICKUP"] as const).map((m) => {
              const enabled = m === "DELIVERY" ? canDeliver : canCollect;
              return (
                <button
                  key={m}
                  type="button"
                  disabled={!enabled || !!payment}
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                  className={`efl-press min-h-[48px] flex-1 rounded-full text-[15px] font-bold disabled:text-[#B5B5B5] ${FOCUS} ${
                    mode === m ? "bg-white shadow-sm" : ""
                  }`}
                >
                  {m === "DELIVERY" ? "Delivery" : "Collection"}
                </button>
              );
            })}
          </div>

          {delivery ? (
            <section aria-labelledby="addr-h" className={card}>
              <h2 id="addr-h" className={h2}>
                Delivery address
              </h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm font-bold sm:col-span-2">
                  Address
                  <input
                    autoComplete="address-line1"
                    value={address.line1}
                    disabled={!!payment}
                    onChange={(e) => setAddress({ ...address, line1: e.target.value })}
                    placeholder="House number and street"
                    className={input}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm font-bold sm:col-span-2">
                  Flat, floor or building (optional)
                  <input
                    autoComplete="address-line2"
                    value={address.line2}
                    disabled={!!payment}
                    onChange={(e) => setAddress({ ...address, line2: e.target.value })}
                    className={input}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm font-bold">
                  Town or city
                  <input
                    autoComplete="address-level2"
                    value={address.city}
                    disabled={!!payment}
                    onChange={(e) => setAddress({ ...address, city: e.target.value })}
                    className={input}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm font-bold">
                  Postcode
                  <input
                    autoComplete="postal-code"
                    autoCapitalize="characters"
                    spellCheck={false}
                    value={address.postcode}
                    disabled={!!payment}
                    onChange={(e) => setAddress({ ...address, postcode: e.target.value })}
                    aria-describedby="pc-note"
                    className={input}
                  />
                </label>
                <p id="pc-note" aria-live="polite" className="m-0 text-sm text-[#5E5E5E] sm:col-span-2">
                  {address.postcode && !fullPostcode
                    ? "Enter your full postcode, like NE1 4ST."
                    : pointQ.isFetching
                      ? "Checking your postcode…"
                      : fullPostcode && pointQ.isSuccess && !point
                        ? "We couldn't find that postcode."
                        : shopsQ.isSuccess && !deliversHere
                          ? `${shop.name} doesn't deliver to ${point?.postcode}.`
                          : here
                            ? `Delivers to ${point?.postcode} in ${eta.min}–${eta.max} min.`
                            : ""}
                </p>
                <label className="flex flex-col gap-1 text-sm font-bold sm:col-span-2">
                  Note for the driver (optional)
                  <input
                    value={address.instructions}
                    disabled={!!payment}
                    onChange={(e) => setAddress({ ...address, instructions: e.target.value })}
                    placeholder="e.g. ring the bell twice"
                    className={input}
                  />
                </label>
              </div>
            </section>
          ) : (
            <section aria-labelledby="collect-h" className={`${card} flex items-start gap-3`}>
              <MapPin aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <h2 id="collect-h" className={h2}>
                  Collect from {shop.name}
                </h2>
                <p className="m-0 mt-1 text-[15px] text-[#5E5E5E]">
                  {[menuQ.data?.store.location.addressLine1, menuQ.data?.store.location.city, menuQ.data?.store.location.postcode]
                    .filter(Boolean)
                    .join(", ")}
                  {` · ready in about ${eta.min}–${eta.max} min`}
                </p>
              </div>
            </section>
          )}

          <section aria-labelledby="when-h" className={card}>
            <h2 id="when-h" className={h2}>
              When
            </h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                aria-pressed={when === "now"}
                disabled={!!payment}
                onClick={() => setWhen("now")}
                className={`efl-press min-h-[64px] rounded-xl border-2 px-4 text-left ${FOCUS} ${when === "now" ? "border-[#0B0B0B]" : "border-[#E2E2E2]"}`}
              >
                <span className="block text-[15px] font-bold">As soon as possible</span>
                <span className="block text-sm text-[#5E5E5E]">
                  {eta.min}–{eta.max} min
                </span>
              </button>
              <label
                className={`flex min-h-[64px] flex-col justify-center rounded-xl border-2 px-4 ${when !== "now" ? "border-[#0B0B0B]" : "border-[#E2E2E2]"}`}
              >
                <span className="text-[15px] font-bold">Schedule</span>
                <select
                  value={when === "now" ? "" : String(when.getTime())}
                  disabled={!!payment}
                  onChange={(e) => setWhen(e.target.value ? new Date(Number(e.target.value)) : "now")}
                  className={`-ml-1 rounded bg-transparent text-sm text-[#5E5E5E] ${FOCUS}`}
                >
                  <option value="">Choose a time</option>
                  {slotList.map((d) => (
                    <option key={d.getTime()} value={String(d.getTime())}>
                      Today {hhmm(d)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <section aria-labelledby="you-h" className={card}>
            <h2 id="you-h" className={h2}>
              Your details
            </h2>
            {session.status === "signedIn" ? (
              <div className="mt-3 flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="m-0 text-[15px]">
                    <span className="font-bold">{customerName(session.customer) || "Signed in"}</span>
                    {session.customer?.email ? <span className="block text-sm text-[#5E5E5E]">{session.customer.email}</span> : null}
                  </p>
                  <button
                    type="button"
                    disabled={!!payment}
                    onClick={() => session.signOut()}
                    className={`efl-press min-h-[44px] rounded-full px-3 text-sm font-bold underline underline-offset-4 ${FOCUS}`}
                  >
                    Not you?
                  </button>
                </div>
                <div id="phone-check">
                  <PhoneCheck />
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-col gap-3">
                <p className="m-0 text-[15px] text-[#5E5E5E]">Sign in so the shop and driver can reach you, and to track your order.</p>
                <button
                  type="button"
                  onClick={() => setSignInOpen(true)}
                  className={`efl-press min-h-[48px] rounded-full bg-[#0B0B0B] px-5 text-[15px] font-bold text-white ${FOCUS}`}
                >
                  Sign in or create an account
                </button>
              </div>
            )}
          </section>
        </div>

        <aside aria-labelledby="order-h" className={`${card} flex flex-col gap-4 lg:sticky lg:top-20`}>
          <h2 id="order-h" className={h2}>
            Your order
          </h2>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {lines.map((l) => (
              <li key={l.key} className="flex gap-3">
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-[15px] font-bold">{l.name}</p>
                  {lineDetail(l) ? <p className="m-0 text-sm leading-snug text-[#5E5E5E]">{lineDetail(l)}</p> : null}
                  <p className="m-0 text-sm font-semibold tabular-nums">{money(l.unitPrice * l.quantity)}</p>
                </div>
                {payment ? (
                  <span className="self-center text-[15px] font-bold tabular-nums">×{l.quantity}</span>
                ) : (
                  <div className="self-center">
                    <Stepper size="sm" min={0} value={l.quantity} label={`Quantity of ${l.name}`} onChange={(n) => setQuantity(l.key, n)} />
                  </div>
                )}
              </li>
            ))}
          </ul>

          {delivery ? (
            <div>
              <p className="m-0 text-[15px] font-bold">Tip your driver</p>
              <p className="m-0 text-sm text-[#5E5E5E]">All of it goes to them.</p>
              <div role="group" aria-label="Tip" className="mt-2 grid grid-cols-4 gap-2">
                {TIPS.map((t, i) => (
                  <button
                    key={t}
                    type="button"
                    disabled={!!payment}
                    aria-pressed={tip === i}
                    onClick={() => setTip(i)}
                    className={`efl-press min-h-[44px] rounded-full text-[15px] font-bold ${FOCUS} ${
                      tip === i ? "bg-[#0B0B0B] text-white" : "bg-[#F3F3F3]"
                    }`}
                  >
                    {t === 0 ? "None" : money(t).replace(".00", "")}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <dl className="m-0 flex flex-col gap-1.5 border-t border-[#E2E2E2] pt-4 text-[15px]">
            <Row label="Subtotal" value={money(subtotal)} />
            {delivery ? <Row label="Delivery" value={here ? (deliveryFee ? money(deliveryFee) : "Free") : "—"} /> : null}
            {delivery && tipAmount ? <Row label="Driver tip" value={money(tipAmount)} /> : null}
            <Row label="Total" value={money(total)} strong />
          </dl>
          {underMinimum ? (
            <p className="m-0 rounded-xl bg-[#F3F3F3] px-4 py-3 text-sm font-semibold">
              Add {money(minimum - subtotal)} more for delivery (minimum {money(minimum)}).
            </p>
          ) : null}

          {payment ? (
            <div id="pay" className="flex flex-col gap-3 border-t border-[#E2E2E2] pt-4">
              <h2 className={h2}>Pay</h2>
              <EflPayment
                publishableKey={payment.key}
                clientSecret={payment.result.clientSecret!}
                stripeAccountId={payment.result.stripeAccountId}
                amountPence={payment.result.amountPence ?? Math.round(payment.result.total * 100)}
                returnUrl={`${window.location.origin}${href(`/orders/${encodeURIComponent(payment.result.orderId)}`)}`}
                onPaid={paid}
              />
              <button
                type="button"
                onClick={() => setPayment(null)}
                className={`efl-press min-h-[44px] rounded-full text-sm font-bold underline underline-offset-4 ${FOCUS}`}
              >
                Change my order
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={place}
              disabled={placing}
              className={`efl-press flex min-h-[56px] w-full items-center justify-between gap-3 rounded-full bg-[#0B0B0B] px-6 text-[16px] font-extrabold text-white disabled:opacity-60 ${FOCUS}`}
            >
              <span className="flex items-center gap-2">
                {placing ? <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" /> : null}
                {session.status === "signedIn" ? "Continue to payment" : "Sign in to order"}
              </span>
              <span className="tabular-nums">{money(total)}</span>
            </button>
          )}
          {error ? (
            <p role="alert" className="m-0 rounded-xl bg-[#FDECEC] px-4 py-3 text-sm font-semibold text-[#9B1C1C]">
              {error}
            </p>
          ) : null}
        </aside>
      </div>
      <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} reason="Sign in to place your order. Your basket stays as it is." />
    </Shell>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between ${strong ? "pt-1 text-lg font-extrabold" : ""}`}>
      <dt>{label}</dt>
      <dd className="m-0 tabular-nums">{value}</dd>
    </div>
  );
}

/** The plain top bar for checkout and orders: back, logo. */
export function Shell({ children }: { children: React.ReactNode }) {
  const href = useEflHref();
  const router = useRouter();
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-[#E2E2E2] bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85">
        <div className="mx-auto flex h-16 max-w-[1100px] items-center gap-2 px-3 sm:px-5">
          <button
            type="button"
            onClick={() => (window.history.length > 1 ? router.back() : router.push(href("/")))}
            aria-label="Back"
            className={`efl-press flex h-11 w-11 items-center justify-center rounded-full hover:bg-[#F3F3F3] ${FOCUS}`}
          >
            <ArrowLeft aria-hidden="true" className="h-6 w-6" />
          </button>
          <Link href={href("/")} className={`rounded-lg ${FOCUS}`}>
            <EflWordmark size={28} />
            <span className="sr-only">Eat For Less home</span>
          </Link>
        </div>
      </header>
      {children}
    </>
  );
}
