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
//
// ⚠️ ANDROID PLUGIN NOTE: app.json's stripe-terminal-react-native plugin
// config deliberately does NOT set "tapToPayCheck": true. Stripe's docs
// call for it — it injects an early-return guard into MainApplication.
// onCreate() (`if (TapToPay.isInTapToPayProcess()) { return }`) meant to
// skip normal init during an OS-triggered Tap to Pay relaunch. On this
// SDK's beta (0.0.1-beta.31) it fired on an ORDINARY cold launch too,
// hanging the whole app on the splash screen — not just Tap to Pay,
// EVERYTHING, since onCreate() returned before React Native finished
// initialising. Re-enable it only after confirming (via adb logcat on a
// real device) that isInTapToPayProcess() no longer misfires, ideally on a
// newer SDK release.

import React from "react";
import { Platform, PermissionsAndroid } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  StripeTerminalProvider,
  useStripeTerminal,
  type Reader,
} from "@stripe/stripe-terminal-react-native";
import { showHowToTap } from "how-to-tap";
import { api } from "./auth";

// Apple requires the "How to Tap" merchant-education overlay to have been
// shown before the app is submitted for review — see modules/how-to-tap.
// Shown once ever (per device), the first time Tap to Pay actually connects,
// not at every connect — nobody wants a tutorial before every charge.
const HOW_TO_TAP_SHOWN_KEY = "oh:howToTapShown";
async function showHowToTapOnce(): Promise<void> {
  try {
    if (Platform.OS !== "ios") return;
    const shown = await AsyncStorage.getItem(HOW_TO_TAP_SHOWN_KEY);
    if (shown) return;
    await showHowToTap();
    await AsyncStorage.setItem(HOW_TO_TAP_SHOWN_KEY, "1");
  } catch {
    // Never let education UI block a real payment flow.
  }
}

// Which Stripe environment the SDK should authenticate against. A SIMULATED
// (no-hardware) reader only exists in Stripe TEST mode, so when the operator
// runs the test drive the connection token MUST be a test-mode token. The mode
// is decided by the token the SDK first receives, so `connect()` sets this flag
// BEFORE it calls initialize() (which is when the SDK first pulls a token).
let pendingSimulated = false;
// Direct charges: the connected account is resolved server-side FROM the
// location, so every connection token — including the ones the SDK fetches
// on its OWN via fetchConnectionToken(), not just the one-off warm-up call
// connectOnDeviceReader() makes for stripeLocationId — must carry the SAME
// locationId, or the SDK's actual session stays scoped to the platform
// account while easyConnect's Stripe Location lives on the connected
// account, producing a "No such location" mismatch. Same set-before-init
// pattern as pendingSimulated, since the SDK's tokenProvider takes no
// arguments — this is the only way to get the location into that callback.
let pendingLocationId: string | undefined;
// Same reasoning, for the order: the backend resolves the connected account
// WITH the order's brandId (a brand can have its own escape-hatch Stripe
// account), so the warm-up call AND every token the SDK fetches on its own
// must carry the SAME orderId — otherwise one resolves with brandId and the
// other without, landing on two different accounts. That mismatch made
// ensureStripeLocation self-heal into an ENDLESS loop: every call disagreed
// with the account the previous call had just saved, so it created a brand
// new Stripe Terminal Location every single time, forever.
let pendingOrderId: string | undefined;
// The mode the SDK actually initialised in. Stripe can't switch a live SDK
// session to test (or back) without re-initialising, which the SDK only does on
// a fresh launch — so a mode change asks the operator to restart the app.
let initMode: "test" | "live" | null = null;
// Guards against overlapping connect() calls — the SDK rejects a second
// discoverReaders while one is running ("SDK is busy with discoverReaders").
let connectInFlight = false;
// Fingerprint of the CURRENTLY connected reader (readerType + live/sim). The
// native SDK session survives the web modal closing and reopening for a new
// order — but the modal's own "Connected" UI is just local React state, so
// it resets and calls connect() again for every new charge even though the
// reader is already paired. Stripe refuses a second discover/connect while
// one is already connected ("You must disconnect from reader before
// discovering readers"), which is exactly the error this was producing.
// connect() checks this FIRST and reuses the existing connection instead of
// re-running discovery — a genuine kind change (switching WisePad ↔ Tap to
// Pay, or live ↔ simulated) disconnects first instead.
// The fingerprint MUST include the connected account, not just the reader
// type. A session opened for one account cannot see PaymentIntents created
// on another — that surfaces as "No such payment_intent" at charge time,
// with the reader looking perfectly connected. Real case that produced it:
// pairing from the Card Readers settings page (no order → LOCATION-level
// account) and then charging an order whose brand has its own escape-hatch
// acct_… (→ BRAND-level account). Same reader type, different account, so a
// type-only fingerprint wrongly reused the session. Orders on the same brand
// still resolve to the same account and still reuse the session, which is
// what keeps repeat charges fast (see the repeat-payment fix above).
let connectedKind: string | null = null;
function kindOf(
  readerType: string | undefined,
  simulated: boolean | undefined,
  stripeAccountId?: string | null,
): string {
  return `${readerType ?? "wisepad"}:${simulated ? "sim" : "live"}:${
    stripeAccountId ?? "platform"
  }`;
}

// ── Connection-token provider ───────────────────────────────────────────────
// The SDK calls this whenever it needs a fresh token. `api` already attaches
// the operator's Bearer token via its request interceptor. `simulated` picks
// the server's test vs live Stripe client (see TerminalService.client()).
export async function fetchConnectionToken(): Promise<string> {
  const res = await api.post<{ secret: string }>(
    "/v1/payments/terminal/connection-token",
    { simulated: pendingSimulated, locationId: pendingLocationId, orderId: pendingOrderId },
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

// Prefixed with "OH" so the operator's existing `adb logcat | grep OH` catches
// the reader steps too — tells us exactly where a connect stalls on-device.
function tlog(step: string, extra?: unknown) {
  // eslint-disable-next-line no-console
  console.log(`[OH term] ${step}`, extra ?? "");
}

// Guard any SDK call that can hang indefinitely (a reader that won't pair, a
// simulator that stalls) so connect() always resolves/rejects and never wedges
// the button into a permanent "still connecting".
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// ── Imperative controller (bridges the WebView event handler → the hook) ────
// useStripeTerminal is a hook, so it can only run inside a React component.
// TerminalHost binds the hook's functions into this singleton; the WebView
// bridge (non-React) then calls terminalController.pay(...).
type ConnectFn = (
  stripeLocationId?: string,
  simulated?: boolean,
  /** "tapToPay" turns THIS device's own NFC into the reader (iOS/Android).
   *  Anything else (or omitted) keeps the existing WisePad 3 Bluetooth path. */
  readerType?: "wisepad" | "tapToPay",
  /** OrderHub's OWN Location.id (cuid) — NOT the Stripe tml_… id above.
   *  Direct charges: fetchConnectionToken()'s tokenProvider calls need this
   *  to resolve the connected account server-side; passing the tml_… id
   *  there 404s ("Location not found") since it isn't an OrderHub id. */
  orderHubLocationId?: string,
  /** The order this payment is for. The backend resolves the connected
   *  account WITH this order's brandId — every token fetch (this connect
   *  AND the SDK's own later refetches) must agree, or they land on
   *  different accounts and the reader can never stay connected. */
  orderId?: string,
  /** The connected account this session will be opened against, as returned
   *  by POST /connection-token. Part of the reuse fingerprint: an existing
   *  session bound to a DIFFERENT account is torn down rather than reused,
   *  since it could not see this charge's PaymentIntent. */
  stripeAccountId?: string | null,
) => Promise<{ label: string }>;
type PayFn = (clientSecret: string) => Promise<{ status: string }>;
/** Apple's Tap to Pay requirement 1.5: warm up at launch/foreground rather
 *  than paying the SDK's initialize() cost when the operator taps Connect.
 *  Takes the SAME orderHubLocationId + orderId as connect() so it resolves
 *  the identical connected account — never a location-only guess — which is
 *  what makes it safe to call ahead of the operator picking a reader. */
type WarmUpFn = (orderHubLocationId: string, orderId: string) => Promise<void>;

interface Controller {
  ready: boolean;
  connectedLabel: string | null;
  connect: ConnectFn;
  pay: PayFn;
  warmUp: WarmUpFn;
}

const notReady = async (): Promise<never> => {
  throw new Error("Card reader not ready yet — open the app and try again.");
};

export const terminalController: Controller = {
  ready: false,
  connectedLabel: null,
  connect: notReady,
  pay: notReady,
  // Best-effort — a warm-up that hasn't run yet (host not mounted) or that
  // fails must never block or surface an error; connect() still works cold.
  warmUp: async () => {},
};

// ── Host component: binds the hook to the controller ────────────────────────
export function TerminalHost(): React.ReactElement | null {
  const {
    initialize,
    discoverReaders,
    cancelDiscovering,
    easyConnect,
    connectReader,
    disconnectReader,
    retrievePaymentIntent,
    collectPaymentMethod,
    confirmPaymentIntent,
    discoveredReaders,
  } = useStripeTerminal({
    onUpdateDiscoveredReaders: (readers) => {
      discovered = readers;
      tlog("readers via callback", readers?.length ?? 0);
    },
  });

  // Belt-and-braces: this SDK build's discovery CALLBACK has proven unreliable
  // (events never reached JS → every discovery "timed out"), but the hook's own
  // discoveredReaders STATE updates through the same native event via setState.
  // Mirror it into the module var so waitForReader() sees readers through
  // whichever path actually delivers.
  React.useEffect(() => {
    if (discoveredReaders && discoveredReaders.length > 0) {
      discovered = discoveredReaders;
      tlog("readers via state", discoveredReaders.length);
    }
  }, [discoveredReaders]);

  // Ask for location/Bluetooth ONCE when the app opens (after login), so the
  // operator grants them up-front — NOT mid-order when they tap "Connect". This
  // only touches OS permissions, never the Stripe SDK, so it stays clear of the
  // lazy-init rule below (and can't interfere with the login handoff).
  React.useEffect(() => {
    void ensureTerminalPermissions().catch(() => {
      /* operator can still grant on first connect */
    });
  }, []);

  React.useEffect(() => {
    // LAZY INIT — nothing touches the Stripe SDK (no initialize, no connection
    // token) at app launch/login; the card-reader layer stays completely inert
    // until it's told about a specific order (via warmUp() or connect()). This
    // still protects the login handoff — only order-scoped code can trigger the
    // SDK — while warmUp() lets the checkout screen pay initialize()'s cost
    // BEFORE the operator taps Connect, satisfying Apple's Tap to Pay
    // requirement that the app warm up ahead of use (see warmUp() below).
    let initialized = false;
    const ensureInit = async () => {
      if (initialized) return;
      const { error } = await initialize();
      if (error) throw new Error(error.message || "Card reader init failed");
      initialized = true;
    };

    const connect: ConnectFn = async (
      stripeLocationId,
      simulated,
      readerType,
      orderHubLocationId,
      orderId,
      stripeAccountId,
    ) => {
      // One connect at a time. discoverReaders runs a CONTINUOUS background scan
      // in this SDK — a second connect while one is mid-flight throws "SDK is
      // busy with another command: discoverReaders". Serialise + always cancel.
      if (connectInFlight) {
        throw new Error("Still connecting the reader — hold on a moment.");
      }
      connectInFlight = true;
      try {
        // Keep the token provider in step with THIS call before anything else
        // — including the reuse path below. The SDK refetches connection
        // tokens on its own schedule; if these still held a previous call's
        // order/location, a later refetch would silently re-scope the live
        // session to a different account.
        pendingSimulated = !!simulated;
        pendingLocationId = orderHubLocationId;
        pendingOrderId = orderId;

        // Already connected as the SAME kind of reader AND the same connected
        // account (e.g. the operator's 2nd, 3rd, ... charge in a shift) —
        // reuse it instead of re-running discovery, which the SDK would
        // reject outright.
        const requestedKind = kindOf(readerType, simulated, stripeAccountId);
        if (terminalController.connectedLabel && connectedKind === requestedKind) {
          tlog("already connected, reusing", { label: terminalController.connectedLabel });
          return { label: terminalController.connectedLabel };
        }
        // Connected as a DIFFERENT kind (switched WisePad ↔ Tap to Pay, or
        // toggled Simulate) — must disconnect before discovering again.
        if (terminalController.connectedLabel && connectedKind !== requestedKind) {
          tlog("switching reader kind, disconnecting first…", {
            from: connectedKind,
            to: requestedKind,
          });
          await disconnectReader?.().catch(() => {});
          terminalController.connectedLabel = null;
          connectedKind = null;
        }

        tlog("connect start", { simulated: !!simulated, stripeLocationId });
        // pendingSimulated/pendingLocationId/pendingOrderId were set at the top
        // of this call — they must already be correct here, because the SDK
        // reads them via the token provider on its FIRST token fetch inside
        // ensureInit() below (and on every later refetch of its own).
        const wantMode: "test" | "live" = simulated ? "test" : "live";
        if (initMode && initMode !== wantMode) {
          throw new Error(
            `The reader is set up in ${initMode} mode. Fully close and reopen the app to switch to ${wantMode} mode, then try again.`,
          );
        }
        // Ask for location/Bluetooth at runtime — Stripe discovery needs it.
        tlog("permissions…");
        await ensureTerminalPermissions();
        tlog("init…");
        await withTimeout(ensureInit(), 20000, "Reader setup"); // first SDK activity
        initMode = wantMode;

        // TAP TO PAY: this device's own NFC hardware IS the reader — no
        // Bluetooth pairing, no separate physical unit. discoverReaders +
        // connectReader collapse into one easyConnect call, same as the
        // simulated-internet test drive below, except there's only ever
        // ONE reader (the phone itself) so there's no "multiple readers
        // found" ambiguity to fall back from. `simulated` still works here
        // — Stripe's Tap to Pay simulator lets you test without tapping a
        // real card. `tosAcceptancePermitted` lets the SDK show Apple's
        // required first-use terms sheet itself instead of us building one.
        if (readerType === "tapToPay") {
          if (!stripeLocationId) {
            throw new Error(
              "Missing the reader's Stripe location — register a reader for this location first, then retry.",
            );
          }
          tlog("easyConnect tapToPay…", { simulated: !!simulated });
          const ttpConnectOnce = () =>
            withTimeout(
              easyConnect({
                discoveryMethod: "tapToPay",
                simulated: !!simulated,
                locationId: stripeLocationId!,
                tosAcceptancePermitted: true,
              }),
              30000,
              "Tap to Pay connect",
            );
          let { reader: ttpReader, error: ttpErr } = await ttpConnectOnce();
          // The native SDK session can genuinely connect while Apple's
          // system Terms & Conditions/account-linking sheet is up — if
          // anything (e.g. the WebView) interrupts the JS side mid-flow,
          // terminalController/connectedKind never get set even though the
          // reader IS connected, so the NEXT attempt hits Stripe's own
          // "already connected" guard. Self-heal: disconnect the orphaned
          // native session and connect fresh, exactly once.
          if (ttpErr?.code === "ALREADY_CONNECTED_TO_READER") {
            tlog("tapToPay already connected natively — resyncing…");
            await disconnectReader?.().catch(() => {});
            ({ reader: ttpReader, error: ttpErr } = await ttpConnectOnce());
          }
          if (ttpErr) {
            // Apple requires iOS 17.6+ for Tap to Pay; on an older OS the SDK
            // reports the device/OS as ineligible rather than a generic
            // connect failure — give the operator something actionable
            // instead of a raw SDK error string.
            if (ttpErr.code === "TAP_TO_PAY_UNSUPPORTED_DEVICE") {
              throw new Error(
                "Tap to Pay needs iOS 17.6 or later on this iPhone. Update iOS in Settings, or use WisePad 3 / the counter reader instead.",
              );
            }
            throw new Error(ttpErr.message);
          }
          const ttpLabel: string = ttpReader?.label ?? "Tap to Pay";
          terminalController.connectedLabel = ttpLabel;
          connectedKind = requestedKind;
          tlog("connected", { label: ttpLabel });
          // Fire-and-forget — never block the reader being ready to charge.
          void showHowToTapOnce();
          return { label: ttpLabel };
        }

        // SIMULATED test drive: skip Bluetooth entirely. This SDK build's
        // simulated BLE discovery never delivered readers to JS (every attempt
        // "timed out"), and the test drive doesn't need Bluetooth anyway —
        // easyConnect discovers + connects a simulated INTERNET reader in ONE
        // native call (no JS event round-trip), then the pay path
        // (retrieve → collect → confirm) is identical to the real WisePad 3.
        if (simulated) {
          tlog("easyConnect simulated…");
          discovered = [];
          const { reader: sim, error: simErr } = await withTimeout(
            easyConnect({
              discoveryMethod: "internet",
              simulated: true,
              ...(stripeLocationId ? { locationId: stripeLocationId } : {}),
            }),
            25000,
            "Simulated reader connect",
          );
          if (!simErr) {
            const simLabel: string = sim?.label ?? "Simulated reader";
            terminalController.connectedLabel = simLabel;
            connectedKind = requestedKind;
            tlog("connected", { label: simLabel });
            return { label: simLabel };
          }
          // Stripe returns SEVERAL simulated internet readers and easyConnect
          // refuses to auto-pick ("Multiple readers found during discovery").
          // Any of them works for the test drive — discover, take the first,
          // and connect it ourselves.
          tlog("easyConnect said", simErr.message);
          let simReader: Reader.Type | null = discovered[0] ?? null;
          if (!simReader) {
            tlog("discover internet…");
            const { error: dErr } = await discoverReaders({
              discoveryMethod: "internet",
              simulated: true,
              timeout: 15,
            });
            if (dErr) tlog("discover internet err", dErr.message);
            simReader = await waitForReader();
            await cancelDiscovering?.().catch(() => {});
          }
          if (!simReader) throw new Error(simErr.message);
          tlog("connectReader internet…", { label: simReader.label });
          const { reader: simConn, error: simConnErr } = await withTimeout(
            connectReader({
              discoveryMethod: "internet",
              reader: simReader,
            }),
            30000,
            "Reader connect",
          );
          if (simConnErr) throw new Error(simConnErr.message);
          const pickedLabel: string =
            simConn?.label ?? simReader.label ?? "Simulated reader";
          terminalController.connectedLabel = pickedLabel;
          connectedKind = requestedKind;
          tlog("connected", { label: pickedLabel });
          return { label: pickedLabel };
        }

        // Clear any scan still running from a previous attempt (else the next
        // discoverReaders is rejected as "SDK busy"), then start fresh.
        await cancelDiscovering?.().catch(() => {});
        discovered = [];
        tlog("discover…");
        // Discover Bluetooth readers. simulated=true returns Stripe's software
        // reader (no hardware, test mode); false finds a real WisePad 3. The
        // SDK-side timeout self-terminates the scan so it can't run forever.
        const { error: discErr } = await discoverReaders({
          discoveryMethod: "bluetoothScan",
          simulated: !!simulated,
          timeout: 15,
        });
        if (discErr) throw new Error(discErr.message);

        const reader = await waitForReader();
        tlog("reader found", reader ? { label: reader.label, id: reader.id } : null);
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
        tlog("connectReader…");
        const { reader: connected, error: connErr } = await withTimeout(
          connectReader({
            discoveryMethod: "bluetoothScan",
            reader,
            locationId: stripeLocationId,
          }),
          30000,
          "Reader connect",
        );
        if (connErr) throw new Error(connErr.message);
        const label: string = connected?.label ?? "Card reader";
        terminalController.connectedLabel = label;
        connectedKind = requestedKind;
        tlog("connected", { label });
        return { label };
      } catch (e: any) {
        tlog("connect FAILED", e?.message ?? String(e));
        throw e;
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

    // Fire the moment a checkout screen opens — well before the operator taps
    // Connect — using the SAME orderHubLocationId + orderId connect() would
    // use, so it resolves the identical connected account rather than a
    // location-only guess. Never throws: a failed/slow warm-up just means
    // connect() pays the init cost itself, same as before this existed.
    const warmUp: WarmUpFn = async (orderHubLocationId, orderId) => {
      if (connectInFlight || terminalController.connectedLabel) return;
      try {
        pendingSimulated = false;
        pendingLocationId = orderHubLocationId;
        pendingOrderId = orderId;
        tlog("warm up…");
        await ensureInit();
        tlog("warm up done");
      } catch (e: any) {
        tlog("warm up FAILED (non-fatal)", e?.message ?? String(e));
      }
    };

    terminalController.connect = connect;
    terminalController.pay = pay;
    terminalController.warmUp = warmUp;
    terminalController.ready = true;

    return () => {
      terminalController.ready = false;
      terminalController.connect = notReady;
      terminalController.pay = notReady;
      terminalController.warmUp = async () => {};
      terminalController.connectedLabel = null;
      connectedKind = null;
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
