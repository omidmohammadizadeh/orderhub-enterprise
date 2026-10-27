// Paying for an order. Eat For Less orders are DIRECT charges on the shop's
// own Stripe account, so the payment sheet is opened against that connected
// account (stripeAccountId from checkout) with the platform's publishable key.
// Apple Pay and Google Pay appear inside the same sheet.

import { initPaymentSheet, initStripe, presentPaymentSheet } from "@stripe/stripe-react-native";
import * as Linking from "expo-linking";
import { APPLE_PAY_MERCHANT_ID, MOCK, STRIPE_PUBLISHABLE_KEY } from "@/config";
import { getConfig } from "@/api/efl";
import type { CheckoutResult } from "@/api/types";

let cachedKey: string | null = null;

/** The platform's publishable key, from GET efl/config so test and live builds
 *  can't be crossed. The EXPO_PUBLIC_ key is a fallback for dev builds only. */
async function publishableKey(): Promise<string | null> {
  if (cachedKey) return cachedKey;
  const fromApi = await getConfig().then((c) => c.stripePublishableKey).catch(() => null);
  cachedKey = fromApi || (__DEV__ ? STRIPE_PUBLISHABLE_KEY || null : null);
  return cachedKey;
}

export type PayOutcome = "paid" | "cancelled" | "redirected";

export async function payForOrder(result: CheckoutResult, customer: { name: string; email?: string }): Promise<PayOutcome> {
  if (MOCK) {
    await new Promise((r) => setTimeout(r, 700));
    return "paid";
  }
  if (result.clientSecret) {
    const key = await publishableKey();
    if (!key) throw new Error("Card payments aren't available right now. Please try again in a moment.");
    await initStripe({
      publishableKey: key,
      stripeAccountId: result.stripeAccountId ?? undefined,
      merchantIdentifier: APPLE_PAY_MERCHANT_ID,
      urlScheme: "eatforless",
    });
    const init = await initPaymentSheet({
      paymentIntentClientSecret: result.clientSecret,
      merchantDisplayName: "Eat For Less",
      returnURL: "eatforless://stripe-redirect",
      defaultBillingDetails: { name: customer.name, email: customer.email },
      applePay: { merchantCountryCode: "GB" },
      googlePay: { merchantCountryCode: "GB", currencyCode: "GBP", testEnv: __DEV__ },
      appearance: {
        colors: { primary: "#0B0B0B", background: "#FFFFFF", componentBackground: "#F3F3F3" },
        shapes: { borderRadius: 14 },
        primaryButton: { shapes: { borderRadius: 26 } },
      },
    });
    if (init.error) throw new Error(init.error.message);
    const presented = await presentPaymentSheet();
    if (presented.error) {
      if (presented.error.code === "Canceled") return "cancelled";
      throw new Error(presented.error.message);
    }
    return "paid";
  }
  if (result.checkoutUrl) {
    // A shop on a hosted-only provider: pay in the browser, track here.
    await Linking.openURL(result.checkoutUrl);
    return "redirected";
  }
  // £0 orders need no payment.
  return "paid";
}
