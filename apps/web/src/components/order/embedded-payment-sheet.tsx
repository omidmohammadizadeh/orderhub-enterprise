// Paying for a storefront order WITHOUT leaving the site — the Apple Pay /
// Google Pay express buttons, with a card form underneath for everyone else.
//
// The order already exists by the time this mounts: POST /checkout created it
// and handed back a PaymentIntent clientSecret. That ordering is deliberate —
// minting a secret from a public route keyed on an order id would let anyone
// who can guess an id start a payment against someone else's order.
//
// The charge is DIRECT on the restaurant's connected account, so Stripe.js has
// to be constructed with the same `stripeAccount` the intent was created on.
// Get that wrong and the secret simply won't confirm, with an error that reads
// like a malformed key rather than the account mismatch it is.

"use client";

import { useMemo, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import {
  Elements,
  ExpressCheckoutElement,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { Loader2, Lock, X } from "lucide-react";

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";

// loadStripe is memoised per connected account. Calling it on every render
// re-downloads Stripe.js and throws away the mounted Elements with it.
const stripeByAccount = new Map<string, Promise<Stripe | null>>();
function stripeFor(account: string): Promise<Stripe | null> {
  let promise = stripeByAccount.get(account);
  if (!promise) {
    promise = loadStripe(PUBLISHABLE_KEY, { stripeAccount: account });
    stripeByAccount.set(account, promise);
  }
  return promise;
}

export interface EmbeddedPaymentSheetProps {
  clientSecret: string;
  /** The connected account the PaymentIntent was created on. */
  stripeAccountId: string;
  /** What Stripe will actually take, including any service charge. */
  amountPence: number;
  orderId: string;
  slug: string;
  brandId?: string | null;
  /** Payment succeeded outright — no redirect happened. */
  onPaid: () => void;
  /** Customer backed out before paying. */
  onCancel: () => void;
}

export function EmbeddedPaymentSheet(props: EmbeddedPaymentSheetProps) {
  const stripePromise = useMemo(
    () => stripeFor(props.stripeAccountId),
    [props.stripeAccountId],
  );

  if (!PUBLISHABLE_KEY) {
    // Better a legible message than an Elements crash: this only happens
    // when the deploy is missing the key, which is an operator problem.
    return (
      <Shell onCancel={props.onCancel} amountPence={props.amountPence}>
        <p className="text-sm text-red-600">
          Card payments aren&apos;t configured on this site. Please choose cash,
          or contact the restaurant.
        </p>
      </Shell>
    );
  }

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret: props.clientSecret,
        appearance: {
          theme: "stripe",
          variables: {
            colorPrimary: "#f97316",
            colorText: "#18181b",
            colorDanger: "#dc2626",
            borderRadius: "8px",
            fontSizeBase: "14px",
          },
        },
      }}
    >
      <PaymentForm {...props} />
    </Elements>
  );
}

function PaymentForm({
  amountPence,
  orderId,
  slug,
  brandId,
  stripeAccountId,
  onPaid,
  onCancel,
}: EmbeddedPaymentSheetProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether the browser actually offers a wallet. Apple Pay needs Safari on a
  // registered domain; Google Pay needs a saved card. When neither is there
  // the element renders nothing, so the "or pay by card" divider would be
  // captioning empty space.
  const [hasWallet, setHasWallet] = useState(false);
  // What Stripe actually decided was available, surfaced on ?walletDebug=1.
  // Apple Pay failing is invisible by design — the button just isn't there —
  // and the causes (domain not registered for THIS shop's account, no card in
  // Wallet, wrong browser) are indistinguishable from the outside. Reading it
  // off the phone beats another round of guessing.
  const [walletDebug, setWalletDebug] = useState<string | null>(null);
  const debugOn =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("walletDebug");

  // 3-D Secure can force a full redirect even from an embedded flow. Send
  // those customers to the same confirmation route the hosted flow used —
  // it bounces to the tracking screen by order id.
  const returnUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const qs = new URLSearchParams({ orderId });
    if (brandId) qs.set("brand", brandId);
    return `${window.location.origin}/order/${slug}/confirmation?${qs.toString()}`;
  }, [orderId, slug, brandId]);

  const confirm = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);

    const submitted = await elements.submit();
    if (submitted.error) {
      setError(submitted.error.message ?? "Please check your card details.");
      setBusy(false);
      return;
    }

    // redirect: "if_required" keeps wallets and most cards on this page, so
    // the customer sees the tracking screen immediately rather than a round
    // trip. Anything needing 3-D Secure still redirects to returnUrl.
    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
      redirect: "if_required",
    });

    if (confirmError) {
      setError(
        confirmError.message ??
          "That payment didn't go through. Please try another card.",
      );
      setBusy(false);
      return;
    }

    // Paid without redirecting. The order is settled server-side by the
    // webhook; the tracking screen polls until it lands.
    onPaid();
  };

  return (
    <Shell onCancel={busy ? undefined : onCancel} amountPence={amountPence}>
      <div className="space-y-4">
        <div className={hasWallet ? "" : "hidden"}>
          <ExpressCheckoutElement
            options={{
              buttonHeight: 48,
              // "always" = show the wallet even when Stripe can't confirm the
              // device has it set up. Stripe's default is to hide it, so a
              // phone with an empty Wallet sees no Apple Pay button at all —
              // and that is most people who have never used it. Tapping it
              // opens Apple's "Add a Payment Card" sheet, which is how the
              // big aggregators do it and how anyone ever starts using Apple
              // Pay in the first place.
              //
              // It also unlocks Apple Pay in Chrome on macOS, which Stripe
              // suppresses entirely on non-Safari desktop without this.
              paymentMethods: { applePay: "always" },
              buttonType: { applePay: "buy", googlePay: "buy" },
            }}
            onReady={({ availablePaymentMethods }) => {
              const record = (methods: unknown) => {
                setHasWallet(Boolean(methods));
                setWalletDebug(
                  methods
                    ? JSON.stringify(methods)
                    : "none — Stripe offered no wallet at all",
                );
              };
              record(availablePaymentMethods);

              // onReady alone is not enough. It fires once, early, and Apple
              // Pay resolves after it — Safari has to ask the device whether
              // Wallet holds a usable card. Gating the row on ready meant
              // Apple Pay could turn up a moment later with nothing listening,
              // so the row stayed hidden for good. Google Pay resolves fast
              // enough to land inside ready, which is exactly why that one
              // worked and Apple Pay never did.
              //
              // availablepaymentmethodschange is Stripe's documented signal
              // for this. The installed react-stripe-js (3.10) has no prop
              // for it, so subscribe on the element itself.
              const el = elements?.getElement("expressCheckout") as any;
              el?.on?.(
                "availablepaymentmethodschange",
                (ev: any) => record(ev?.availablePaymentMethods),
              );
            }}
            onConfirm={confirm}
            onCancel={() => setBusy(false)}
          />
          <div className="my-4 flex items-center gap-3">
            <span className="h-px flex-1 bg-zinc-200" />
            <span className="text-[11px] uppercase tracking-wider text-zinc-400">
              or pay by card
            </span>
            <span className="h-px flex-1 bg-zinc-200" />
          </div>
        </div>

        <PaymentElement options={{ layout: "tabs" }} />

        {debugOn && (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-zinc-100 p-2 text-[10px] text-zinc-700">
            {`wallets: ${walletDebug ?? "onReady never fired"}
account: ${stripeAccountId}
host:    ${typeof window !== "undefined" ? window.location.host : "?"}`}
          </pre>
        )}

        {error && <p className="text-[12px] text-red-600">{error}</p>}

        <button
          onClick={confirm}
          disabled={!stripe || busy}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Lock className="h-3.5 w-3.5" />
          )}
          Pay £{(amountPence / 100).toFixed(2)}
        </button>

        <p className="text-center text-[11px] text-zinc-500">
          Payments are processed securely by Stripe.
        </p>
      </div>
    </Shell>
  );
}

function Shell({
  children,
  onCancel,
  amountPence,
}: {
  children: React.ReactNode;
  onCancel?: () => void;
  amountPence: number;
}) {
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
      <div className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 sm:max-w-md sm:rounded-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">Payment</h2>
            <p className="text-xs text-zinc-500">
              £{(amountPence / 100).toFixed(2)} to complete your order
            </p>
          </div>
          {onCancel && (
            <button
              onClick={onCancel}
              aria-label="Close payment"
              className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
