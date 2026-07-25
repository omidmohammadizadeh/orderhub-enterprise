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
import { Platform, PermissionsAndroid } from "react-native";
import {
  StripeTerminalProvider,
  useStripeTerminal,
  type Reader,
} from "@stripe/stripe-terminal-react-native";
import { api } from "./auth";

// Which Stripe environment the SDK should authenticate against. A SIMULATED
// (no-hardware) reader only exists in Stripe TEST mode, so when the operator
// runs the test drive the connection token MUST be a test-mode token. The mode
// is decided by the token the SDK first receives, so `connect()` sets this flag
// BEFORE it calls initialize() (which is when the SDK first pulls a token).
let pendingSimulated = false;
// The mode the SDK actually initialised in. Stripe can't switch a live SDK
// session to test (or back) without re-initialising, which the SDK only does on
// a fresh launch — so a mode change asks the operator to restart the app.
let initMode: "test" | "live" | null = null;
// Guards against overlapping connect() calls — the SDK rejects a second
// discoverReaders while one is running ("SDK is busy with discoverReaders").
let connectInFlight = false;

// ── Connection-token provider ───────────────────────────────────────────────
// The SDK calls this whenever it needs a fresh token. `api` already attaches
// the operator's Bearer token via its request interceptor. `simulated` picks
// the server's test vs live Stripe client (see TerminalService.client()).
export async function fetchConnectionToken(): Promise<string> {
  const res = await api.post<{ secret: string }>(
    "/v1/payments/terminal/connection-token",
    { simulated: pendingSimulated },
  );
  return res.data.secret;
}

// Stripe Terminal needs runtime LOCATION permission (and, on Android 12+, the
// new Bluetooth scan/connect permissions) BEFORE it can discover a reader.
// Without them discovery finds nothing and connect() just spins. iOS is handled
// by the Info.plist strings + the SDK's own prompts, so this is Android-only.
async function ensureTerminalPermissions(): Promise<void> {
  if (Platform.OS !== "android") return;
  const wanted: string[] = [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  if (Number(Platform.Version) >= 31) {
    wanted.push(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    );
  }
  const result = await PermissionsAndroid.requestMultiple(wanted as any);
  if (
    result[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] !==
    PermissionsAndroid.RESULTS.GRANTED
  ) {
    throw new Error(
      "Location permission is required to connect the card reader. Enable it for Order Hub in Settings, then try again.",
    );
  }
}

// ── Imperative controller (bridges the WebView event handler → the hook) ────
// useStripeTerminal is a hook, so it can only run inside a React component.
// TerminalHost binds the hook's functions into this singleton; the WebView
// bridge (non-React) then calls terminalController.pay(...).
type ConnectFn = (
  stripeLocationId?: string,
  simulated?: boolean,
) => Promise<{ label: string }>;
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
    cancelDiscovering,
    connectReader,
    disconnectReader,
    retrievePaymentIntent,
    collectPaymentMethod,
    confirmPaymentIntent,
  } = useStripeTerminal({
    onUpdateDiscoveredReaders: (readers) => {
      discovered = readers;
    },
  });

  React.useEffect(() => {
    // LAZY INIT — nothing touches the Stripe SDK (no initialize, no connection
    // token) until the operator actually connects a reader. So at app launch /
    // login the card-reader layer is completely inert and cannot interfere with
    // the login handoff or anything else.
    let initialized = false;
    const ensureInit = async () => {
      if (initialized) return;
      const { error } = await initialize();
      if (error) throw new Error(error.message || "Card reader init failed");
      initialized = true;
    };

    const connect: ConnectFn = async (stripeLocationId, simulated) => {
      // One connect at a time. discoverReaders runs a CONTINUOUS background scan
      // in this SDK — a second connect while one is mid-flight throws "SDK is
      // busy with another command: discoverReaders". Serialise + always cancel.
      if (connectInFlight) {
        throw new Error("Still connecting the reader — hold on a moment.");
      }
      connectInFlight = true;
      try {
        // Decide the Stripe environment BEFORE init: the token provider reads
        // pendingSimulated when the SDK pulls its first token in ensureInit().
        pendingSimulated = !!simulated;
        const wantMode: "test" | "live" = simulated ? "test" : "live";
        if (initMode && initMode !== wantMode) {
          throw new Error(
            `The reader is set up in ${initMode} mode. Fully close and reopen the app to switch to ${wantMode} mode, then try again.`,
          );
        }
        // Ask for location/Bluetooth at runtime — Stripe discovery needs it.
        await ensureTerminalPermissions();
        await ensureInit(); // ← first SDK activity happens HERE, not at launch
        initMode = wantMode;
        // Clear any scan still running from a previous attempt (else the next
        // discoverReaders is rejected as "SDK busy"), then start fresh.
        await cancelDiscovering?.().catch(() => {});
        discovered = [];
        // Discover Bluetooth readers. simulated=true returns Stripe's software
        // reader (no hardware, test mode); false finds a real WisePad 3.
        const { error: discErr } = await discoverReaders({
          discoveryMethod: "bluetoothScan",
          simulated: !!simulated,
        });
        if (discErr) throw new Error(discErr.message);

        const reader = await waitForReader();
        // Stop the background scan before connecting — leaving it running is
        // what wedges the SDK into the "busy" state on the next attempt.
        await cancelDiscovering?.().catch(() => {});
        if (!reader) {
          throw new Error("No card reader found. Is it on and nearby?");
        }

        // SDK v0.0.1-beta.31: connectReader takes ONE object with
        // discoveryMethod inside; a Stripe location id (tml_…) is REQUIRED for
        // Bluetooth readers.
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
      } finally {
        connectInFlight = false;
      }
    };

    const pay: PayFn = async (clientSecret) => {
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

    return () => {
      terminalController.ready = false;
      terminalController.connect = notReady;
      terminalController.pay = notReady;
      void disconnectReader?.().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

// ── Terminal mount — render as a SIBLING of the POS WebView, not a wrapper ──
// The WebView bridge reaches the SDK through the terminalController singleton,
// NOT through React context, so the WebView must NOT be a child of the
// provider. Wrapping it caused the WebView to remount (re-firing the one-time
// login handoff → login loop). This renders the provider + host on their own
// (TerminalHost draws nothing) so they can never interfere with the WebView.
export function TerminalMount(): React.ReactElement {
  return React.createElement(
    StripeTerminalProvider,
    { logLevel: "verbose", tokenProvider: fetchConnectionToken } as any,
    React.createElement(TerminalHost),
  );
}
