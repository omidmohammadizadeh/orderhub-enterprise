// BBPOS WisePad 3 (and, later, Tap to Pay) via the Stripe Terminal SDK.
//
// The S700 is server-driven (the API pushes the charge to it). A WisePad 3 is
// a BLUETOOTH reader driven by the Stripe Terminal SDK running ON this device,
// so the native app owns: getting a connection token, discovering + connecting
// the reader, and collecting + confirming the payment on it.
//
// Division of labour with the web POS (kept thin so the WebView stays the
// source of truth for orders/pricing):
//   • The web POS creates the charge — POST /v1/payments/terminal/charge/mobile
//     → { clientSecret } — and then calls window.OrderHubTerminal.pay(clientSecret).
//   • This native module discovers/connects the reader and runs
//     retrieve → collect → confirm on that clientSecret.
//   • On success the web POS polls /v1/payments/terminal/charge/status to
//     settle the order PAID (same endpoint the S700 uses).
//
// ⚠️ BUILD NOTE: this file imports @stripe/stripe-terminal-react-native, which
// is a NATIVE module. It requires:
//     npx expo install @stripe/stripe-terminal-react-native
//   then a fresh EAS dev build (not Expo Go). The exact hook/function
//   signatures below track the SDK's documented API — pin the version and
//   verify against it after install (the SDK's connect/collect names have
//   shifted across versions; the version-sensitive calls are flagged).

import React from "react";
import {
  StripeTerminalProvider,
  useStripeTerminal,
  type Reader,
} from "@stripe/stripe-terminal-react-native";
import { api } from "./auth";

// ── Connection-token provider ───────────────────────────────────────────────
// The SDK calls this whenever it needs a fresh token. `api` already attaches
// the operator's Bearer token via its request interceptor.
export async function fetchConnectionToken(): Promise<string> {
  const res = await api.post<{ secret: string }>(
    "/v1/payments/terminal/connection-token",
    {},
  );
  return res.data.secret;
}

// ── Imperative controller (bridges the WebView event handler → the hook) ────
// useStripeTerminal is a hook, so it can only run inside a React component.
// TerminalHost binds the hook's functions into this singleton; the WebView
// bridge (non-React) then calls terminalController.pay(...).
type ConnectFn = (stripeLocationId?: string) => Promise<{ label: string }>;
type PayFn = (clientSecret: string) => Promise<{ status: string }>;

interface Controller {
  ready: boolean;
  connectedLabel: string | null;
  connect: ConnectFn;
  pay: PayFn;
}

const notReady = async (): Promise<never> => {
  throw new Error("Card reader not ready yet — open the app and try again.");
};

export const terminalController: Controller = {
  ready: false,
  connectedLabel: null,
  connect: notReady,
  pay: notReady,
};

// ── Host component: binds the hook to the controller ────────────────────────
export function TerminalHost(): React.ReactElement | null {
  const {
    initialize,
    discoverReaders,
    connectReader,
    disconnectReader,
    retrievePaymentIntent,
    collectPaymentMethod,
    confirmPaymentIntent,
    connectedReader,
  } = useStripeTerminal({
    onUpdateDiscoveredReaders: (readers) => {
      discovered = readers;
    },
  });

  // Hold the latest discovery result so connect() can pick one.
  const discoveredRef = React.useRef<Reader.Type[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const { error } = await initialize();
      if (error || cancelled) return;

      const connect: ConnectFn = async (stripeLocationId) => {
        // 1. Discover Bluetooth readers (simulated=false for a real WisePad 3;
        //    set true when testing against the SDK's simulated reader).
        const { error: discErr } = await discoverReaders({
          discoveryMethod: "bluetoothScan",
          simulated: false,
        });
        if (discErr) throw new Error(discErr.message);

        // Give discovery a moment to surface a reader.
        const reader = await waitForReader();
        if (!reader) throw new Error("No card reader found. Is it on and nearby?");

        // 2. Connect. SDK v0.0.1-beta.31: connectReader takes ONE object with
        //    discoveryMethod inside; a Stripe location id (tml_…) is REQUIRED
        //    for Bluetooth readers — the POS passes it (from listReaders'
        //    stripeLocationId).
        if (!stripeLocationId) {
          throw new Error(
            "Missing the reader's Stripe location — register a reader for this location first, then retry.",
          );
        }
        const { reader: connected, error: connErr } = await connectReader({
          discoveryMethod: "bluetoothScan",
          reader,
          locationId: stripeLocationId,
        });
        if (connErr) throw new Error(connErr.message);
        const label: string = connected?.label ?? "Card reader";
        terminalController.connectedLabel = label;
        return { label };
      };

      const pay: PayFn = async (clientSecret) => {
        if (!connectedReader) {
          throw new Error("Connect the card reader first.");
        }
        // retrieve → collect → confirm on the client secret from the server.
        const { paymentIntent, error: rErr } =
          await retrievePaymentIntent(clientSecret);
        if (rErr || !paymentIntent) {
          throw new Error(rErr?.message ?? "Could not read the payment.");
        }
        const { error: cErr } = await collectPaymentMethod({ paymentIntent });
        if (cErr) throw new Error(cErr.message);
        const { paymentIntent: done, error: confErr } =
          await confirmPaymentIntent({ paymentIntent });
        if (confErr) throw new Error(confErr.message);
        return { status: done?.status ?? "succeeded" };
      };

      terminalController.connect = connect;
      terminalController.pay = pay;
      terminalController.ready = true;
    })().catch(() => {
      /* leave controller in not-ready state on init failure */
    });

    return () => {
      cancelled = true;
      terminalController.ready = false;
      terminalController.connect = notReady;
      terminalController.pay = notReady;
      void disconnectReader?.().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the discovery ref in sync (module-level `discovered` is written by the
  // callback above, which can't touch component state directly).
  React.useEffect(() => {
    discoveredRef.current = discovered;
  });

  return null;
}

// Discovered readers are delivered via the SDK callback; stash + poll for one.
let discovered: Reader.Type[] = [];
async function waitForReader(timeoutMs = 12000): Promise<Reader.Type | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (discovered.length > 0) return discovered[0]!;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

// ── Provider wrapper — put this around the authed part of the app ───────────
export function TerminalRoot({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return React.createElement(
    StripeTerminalProvider,
    { logLevel: "verbose", tokenProvider: fetchConnectionToken } as any,
    children,
    React.createElement(TerminalHost),
  );
}
