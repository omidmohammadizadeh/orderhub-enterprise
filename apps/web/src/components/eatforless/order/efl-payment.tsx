"use client";

// Paying for an Eat For Less order on the website: Apple Pay / Google Pay
// buttons, with Stripe's card form underneath.
//
// The order exists before this opens (checkout created it and its
// PaymentIntent). Once Eat For Less has its own Stripe the charge is on
// Eat For Less's account (its key, no stripeAccount); before that it was a
// direct charge on the shop's account, which Stripe.js must be told about or
// the secret won't confirm. The checkout response says which.

import { useMemo, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements, ExpressCheckoutElement, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Loader2, Lock } from "lucide-react";
import { FOCUS } from "../efl-styles";
import { money } from "../feed/shop-card";

// Memoised per key and account: a new loadStripe per render would re-download
// Stripe.js and throw away the mounted form.
const stripes = new Map<string, Promise<Stripe | null>>();
function stripeFor(key: string, account: string | null): Promise<Stripe | null> {
  const id = `${key}|${account ?? ""}`;
  let p = stripes.get(id);
  if (!p) {
    p = loadStripe(key, account ? { stripeAccount: account } : undefined);
    stripes.set(id, p);
  }
  return p;
}

export type EflPaymentProps = {
  publishableKey: string;
  clientSecret: string;
  stripeAccountId: string | null;
  amountPence: number;
  /** Where 3-D Secure sends the customer back to: their order's page. */
  returnUrl: string;
  onPaid: () => void;
};

export function EflPayment(props: EflPaymentProps) {
  const stripe = useMemo(() => stripeFor(props.publishableKey, props.stripeAccountId), [props.publishableKey, props.stripeAccountId]);
  return (
    <Elements
      stripe={stripe}
      options={{
        clientSecret: props.clientSecret,
        appearance: {
          theme: "stripe",
          variables: {
            colorPrimary: "#0B0B0B",
            colorText: "#0B0B0B",
            colorDanger: "#B42318",
            borderRadius: "12px",
            fontSizeBase: "16px",
          },
        },
      }}
    >
      <PaymentForm {...props} />
    </Elements>
  );
}

function PaymentForm({ amountPence, returnUrl, onPaid }: EflPaymentProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The wallet row renders nothing when the browser offers no wallet, so the
  // "or pay by card" divider waits until one is actually there.
  const [hasWallet, setHasWallet] = useState(false);

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
    // Wallets and most cards finish here; 3-D Secure may still redirect.
    const { error: failed } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
      redirect: "if_required",
    });
    if (failed) {
      setError(failed.message ?? "That payment didn't go through. Please try another card.");
      setBusy(false);
      return;
    }
    onPaid();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className={hasWallet ? "" : "hidden"}>
        <ExpressCheckoutElement
          options={{ buttonHeight: 52, paymentMethods: { applePay: "always" }, buttonType: { applePay: "buy", googlePay: "buy" } }}
          onReady={({ availablePaymentMethods }) => {
            setHasWallet(Boolean(availablePaymentMethods));
            // Apple Pay can turn up after ready (Safari asks the device
            // first), so keep listening.
            const el = elements?.getElement("expressCheckout") as unknown as
              | { on?: (ev: string, cb: (e: { availablePaymentMethods?: unknown }) => void) => void }
              | null;
            el?.on?.("availablepaymentmethodschange", (e) => setHasWallet(Boolean(e?.availablePaymentMethods)));
          }}
          onConfirm={confirm}
          onCancel={() => setBusy(false)}
        />
        <div className="my-4 flex items-center gap-3">
          <span className="h-px flex-1 bg-[#E2E2E2]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[#5E5E5E]">or pay by card</span>
          <span className="h-px flex-1 bg-[#E2E2E2]" />
        </div>
      </div>

      <PaymentElement options={{ layout: "tabs" }} />

      {error ? (
        <p role="alert" className="m-0 rounded-xl bg-[#FDECEC] px-4 py-3 text-sm font-semibold text-[#9B1C1C]">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={confirm}
        disabled={!stripe || busy}
        className={`efl-press flex min-h-[56px] w-full items-center justify-center gap-2 rounded-full bg-[#0B0B0B] text-[16px] font-extrabold text-white disabled:opacity-50 ${FOCUS}`}
      >
        {busy ? <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" /> : <Lock aria-hidden="true" className="h-4 w-4" />}
        Pay {money(amountPence / 100)}
      </button>
      <p className="m-0 text-center text-xs text-[#5E5E5E]">Payments are processed securely by Stripe.</p>
    </div>
  );
}
