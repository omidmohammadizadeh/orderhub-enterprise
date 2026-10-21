// Order Hub Driver — native delivery app.
//
// App is the orchestrator: it owns auth, polls my-day, derives online status,
// keeps a *persistent* foreground location watch (so the car never disappears
// when screens change), and routes between screens. When orders are dispatched
// the job card takes over and stays up until each stop is delivered/skipped,
// then advances to the next stop automatically.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, Alert, AppState, Platform, Vibration, View } from "react-native";
import * as Location from "expo-location";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";

import {
  useAuth,
  DriverProfile,
  Job,
  MyDay,
  getMe,
  getMyDay,
  goOffline,
  goOnline,
  sendPing,
  getOperatorChat,
  sendOperatorChat,
  getOperatorChatUnread,
  getCustomerChat,
  sendCustomerChat,
} from "@/services/auth";
import { ChatScreen } from "@/screens/ChatScreen";
import { configureGoogleSignIn } from "@/services/google";
import {
  pingNow,
  startLocationUpdates,
  stopLocationUpdates,
} from "@/services/location";
import {
  attachJobResponseHandler,
  clearNotificationBadges,
  pushPermissionGranted,
  registerForPush,
  setupJobCategory,
} from "@/services/notifications";
import { applyDownloadedUpdate, downloadUpdateIfAvailable } from "@/services/updates";
import { LoginScreen } from "@/screens/LoginScreen";
import { HomeScreen } from "@/screens/HomeScreen";
import { JobScreen } from "@/screens/JobScreen";
import { ProfileScreen } from "@/screens/ProfileScreen";
import { OrdersScreen } from "@/screens/OrdersScreen";
import { CashUpScreen } from "@/screens/CashUpScreen";
import { LocationDisclosure } from "@/components/LocationDisclosure";
import type { OrdersTab } from "@/components/Drawer";
import { NewJobBanner } from "@/components/NewJobBanner";
import { C } from "@/theme";

// heading: degrees from north, null when the phone has no fix on it (iOS
// reports -1 then).
export type LatLng = { latitude: number; longitude: number; heading?: number | null };

function toPos(c: Location.LocationObjectCoords): LatLng {
  return {
    latitude: c.latitude,
    longitude: c.longitude,
    heading: c.heading != null && c.heading >= 0 ? c.heading : null,
  };
}

const LOCATION_CONSENT_KEY = "orderhub.driver.locationConsent";

export default function App() {
  const { tokens, hydrated, setTokens } = useAuth();

  const [me, setMe] = useState<DriverProfile | null>(null);
  const [day, setDay] = useState<MyDay | null>(null);
  const [busy, setBusy] = useState(false);

  // Navigation overlays (opened from the drawer menu).
  const [overlay, setOverlay] = useState<null | "profile" | "cashup" | "chat">(null);
  const [chatUnread, setChatUnread] = useState(0);
  const [customerChatOrderId, setCustomerChatOrderId] = useState<string | null>(null);
  const [ordersTab, setOrdersTab] = useState<OrdersTab | null>(null);
  const [manualJob, setManualJob] = useState<Job | null>(null); // opened from a list
  const [minimized, setMinimized] = useState(false); // peek the map while a job is ASSIGNED (not started)

  // Prominent location-disclosure gate — ANDROID ONLY (Google Play's
  // background-location policy requires it there). iOS shows NO custom
  // message before the permission request: App Review rejected pre-permission
  // UI twice under Guideline 5.1.1(iv) (any message with an exit path), so on
  // iOS going online proceeds DIRECTLY to Apple's own permission dialogs —
  // the Info.plist purpose strings carry the explanation.
  const [locationConsent, setLocationConsent] = useState(Platform.OS === "ios");
  // The stored answer arrives asynchronously; until it has, "no consent" is
  // only "not read yet" and must not be acted on.
  const [consentLoaded, setConsentLoaded] = useState(Platform.OS === "ios");
  const [showDisclosure, setShowDisclosure] = useState(false);
  useEffect(() => {
    if (Platform.OS === "ios") return; // no disclosure gate on iOS
    SecureStore.getItemAsync(LOCATION_CONSENT_KEY)
      .then((v) => setLocationConsent(v === "1"))
      .catch(() => {})
      .finally(() => setConsentLoaded(true));
  }, []);

  // Live driver position — owned here so it survives screen changes.
  const [pos, setPos] = useState<LatLng | null>(null);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const lastPingRef = useRef(0);

  const online = me?.presence?.status === "ONLINE" || me?.presence?.status === "ON_JOB";

  useEffect(() => {
    configureGoogleSignIn();
  }, []);

  // Whether this phone will actually ring for a job. iOS asks once, so a
  // driver who declined is silently unreachable for ever — HomeScreen says so
  // rather than leaving them wondering why work never arrives.
  const [pushBlocked, setPushBlocked] = useState(false);

  // Clear the app-icon badge + tray notifications on launch and whenever the
  // app returns to the foreground.
  useEffect(() => {
    clearNotificationBadges();
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") return;
      clearNotificationBadges();
      // They may have just come back from Settings having turned alerts on —
      // and if so, register the token we could never get before.
      pushPermissionGranted()
        .then((ok) => {
          setPushBlocked(!ok);
          if (ok) registerForPush();
        })
        .catch(() => undefined);
    });
    return () => sub.remove();
  }, []);

  const refresh = useCallback(async () => {
    // Settled, not all: these two calls are independent, and Promise.all made
    // them share a fate. One failing /driver/me (a refresh-token race, a blip)
    // rejected the pair, so setDay never ran and a freshly dispatched job never
    // surfaced — while the poll kept logging a healthy my-day 200 every 8s.
    const [m, d] = await Promise.allSettled([getMe(), getMyDay()]);
    if (m.status === "fulfilled") setMe(m.value);
    if (d.status === "fulfilled") setDay(d.value);
    try {
      setChatUnread(await getOperatorChatUnread());
    } catch {
      // ignore
    }
  }, []);

  // Poll while signed in so dispatched jobs surface and multi-drop advances.
  useEffect(() => {
    if (!tokens) {
      setMe(null);
      setDay(null);
      return;
    }
    refresh();
    const t = setInterval(refresh, 8_000);
    return () => clearInterval(t);
  }, [tokens, refresh]);

  // Push setup once signed in.
  useEffect(() => {
    if (!tokens) return;
    setupJobCategory();
    registerForPush().then(() =>
      pushPermissionGranted()
        .then((ok) => setPushBlocked(!ok))
        .catch(() => setPushBlocked(false)),
    );
    const detach = attachJobResponseHandler({
      onJobAccepted: () => refresh(),
      onOpenChat: (info) => {
        if (info.channel === "CUSTOMER_DRIVER" && info.orderId) {
          setCustomerChatOrderId(info.orderId);
        } else {
          setOverlay("chat");
        }
      },
    });
    return detach;
  }, [tokens, refresh]);

  // ── Persistent location watch (tied to online status, not to a screen) ──────
  const startWatch = useCallback(async () => {
    if (watchRef.current) return;
    // NEVER request here — this runs from an effect (e.g. presence resumed
    // ONLINE from a previous session), so a request would pop Apple's dialog
    // without a driver tap (Guideline 5.1.1(iv)). Tap paths do the requesting.
    const fg = await Location.getForegroundPermissionsAsync();
    if (fg.status !== "granted") return;
    try {
      const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setPos(toPos(cur.coords));
    } catch {
      /* ignore */
    }
    watchRef.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 20 },
      (loc) => {
        setPos(toPos(loc.coords));
        const now = Date.now();
        if (now - lastPingRef.current > 10_000) {
          lastPingRef.current = now;
          sendPing({
            lat: loc.coords.latitude,
            lng: loc.coords.longitude,
            heading: loc.coords.heading ?? undefined,
            speed: loc.coords.speed ?? undefined,
          }).catch(() => {});
        }
      },
    );
  }, []);

  const stopWatch = useCallback(() => {
    watchRef.current?.remove();
    watchRef.current = null;
  }, []);

  // Heartbeat. The watch only pings after 20 m of movement, so a driver
  // parked at the shop between runs went silent and dispatch couldn't tell
  // "waiting" from "app closed / no signal". Re-send the last position every
  // minute while online so the operator's "last seen" stays honest.
  const posRef = useRef<LatLng | null>(null);
  posRef.current = pos;
  useEffect(() => {
    if (!online || !locationConsent) return;
    const t = setInterval(() => {
      const p = posRef.current;
      if (!p || Date.now() - lastPingRef.current < 55_000) return;
      lastPingRef.current = Date.now();
      sendPing({ lat: p.latitude, lng: p.longitude, heading: p.heading ?? undefined }).catch(() => {});
    }, 15_000);
    return () => clearInterval(t);
  }, [online, locationConsent]);

  // Location only ever starts once the driver has consented via the prominent
  // disclosure — so no system location prompt can fire before it (Play policy).
  useEffect(() => {
    if (online && locationConsent) {
      startWatch();
      startLocationUpdates().catch(() => {});
    } else {
      stopWatch();
      stopLocationUpdates().catch(() => {});
    }
  }, [online, locationConsent, startWatch, stopWatch]);

  // That effect fires once per change of online/consent — and both can be true
  // before the OS grant lands (consent is recorded before the permission
  // dialog; a driver mid-run is already online). Both starters bail without a
  // grant, so tracking silently never began. Retry whenever the app comes back
  // to the foreground — which is also how a grant made in Settings arrives.
  const ensureTracking = useCallback(() => {
    if (!online || !locationConsent) return;
    startWatch();
    startLocationUpdates().catch(() => {});
  }, [online, locationConsent, startWatch]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") ensureTracking();
    });
    return () => sub.remove();
  }, [ensureTracking]);

  const runOnline = useCallback(
    async (next: boolean) => {
      setBusy(true);
      try {
        if (next) {
          await goOnline();
          await pingNow();
        } else {
          await goOffline();
        }
        await refresh();
      } catch (err) {
        Alert.alert("Error", (err as Error)?.message ?? "Try again");
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  // The server can auto-resume presence=ONLINE from a previous session.
  // Going online must ALWAYS be the driver's own tap — an uninvited system
  // location prompt at first launch is exactly what App Review keeps
  // rejecting (5.1.1(iv)) and it confused drivers. On launch, if we come up
  // ONLINE without a usable location grant on THIS device, quietly drop to
  // OFFLINE; the driver flips the toggle when ready, and THAT tap triggers
  // the permission dialogs.
  //
  // Never for a driver holding stops, though. Going offline clears their
  // active-job pointer, hides them from dispatch and stops the customer's live
  // tracking — mid-delivery, just because they opened the app on a new phone.
  // On Android show the disclosure so they can turn location on; iOS can't
  // prompt without a tap, so leave them online with their run.
  const reconciledRef = useRef(false);
  useEffect(() => {
    if (reconciledRef.current || !online || !consentLoaded || !day) return;
    reconciledRef.current = true;
    (async () => {
      try {
        const fg = await Location.getForegroundPermissionsAsync();
        const deviceReady =
          fg.status === "granted" &&
          (Platform.OS === "ios" || locationConsent);
        if (deviceReady) return;
        const holdingStops = day.active.length > 0 || me?.presence?.status === "ON_JOB";
        if (holdingStops) {
          if (Platform.OS !== "ios") setShowDisclosure(true);
          return;
        }
        await runOnline(false);
      } catch {
        /* leave presence as-is */
      }
    })();
  }, [online, consentLoaded, day, me, locationConsent, runOnline]);

  // Going online starts location sharing. Android: prominent disclosure
  // first (Google Play policy), which then requests permission. iOS: the
  // driver's tap leads STRAIGHT to Apple's own permission dialog — no custom
  // UI before it (Guideline 5.1.1(iv)); a denial gets an informational
  // alert with a Settings link, which Apple's guidance explicitly allows.
  const toggleOnline = useCallback(
    async (next: boolean) => {
      if (next && Platform.OS !== "ios" && !locationConsent) {
        setShowDisclosure(true);
        return;
      }
      if (next && Platform.OS === "ios") {
        const fg = await Location.requestForegroundPermissionsAsync();
        if (fg.status !== "granted") {
          Alert.alert(
            "Location needed to go online",
            "Order Hub Driver shares your live location with dispatch and customers while you're online. Allow location access in Settings to go online.",
            [
              { text: "Not now", style: "cancel" },
              { text: "Open Settings", onPress: () => Linking.openSettings() },
            ],
          );
          return;
        }
        // Always/background upgrade — must ride the same tap; the location
        // start-up code is deliberately passive and never requests. Optional:
        // "Keep Only While Using" still goes online (foreground pings work).
        try {
          await Location.requestBackgroundPermissionsAsync();
        } catch {
          // optional
        }
      }
      await runOnline(next);
    },
    [locationConsent, runOnline],
  );

  async function acceptDisclosure() {
    try {
      await SecureStore.setItemAsync(LOCATION_CONSENT_KEY, "1");
    } catch {
      // proceed regardless — consent is captured for this session
    }
    setLocationConsent(true);
    setShowDisclosure(false);
    // App Review Guideline 5.1.1(iv): the system permission request must
    // ALWAYS follow the pre-permission message. Fire it directly rather than
    // relying on the go-online chain, which can bail early (e.g. network
    // error) and leave the message with no prompt after it.
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      // Background permission must also be requested from the tap chain —
      // the location start-up code is passive and never requests.
      if (fg.status === "granted") await Location.requestBackgroundPermissionsAsync();
    } catch {
      // never block going online on this
    }
    // Already online (a driver mid-run on a new phone) means the tracking
    // effect won't fire again — start it now the grant exists. Called directly:
    // this closure still holds the pre-consent render.
    if (online) {
      startWatch();
      startLocationUpdates().catch(() => {});
    }
    runOnline(true);
  }

  // Android-only: Google Play's prominent-disclosure policy requires a
  // decline path. On iOS the modal has no exit affordance (Guideline
  // 5.1.1(iv)) so this never fires there.
  function declineDisclosure() {
    setShowDisclosure(false);
    // Being online requires location consent — if they decline, go offline.
    // Except mid-run: that would orphan the stops they're carrying.
    const holdingStops = (day?.active.length ?? 0) > 0 || me?.presence?.status === "ON_JOB";
    if (online && !holdingStops) runOnline(false);
  }

  // ── Active-job routing ──────────────────────────────────────────────────────
  // Stops in driving order; the driver can swipe between them. Sequence alone
  // isn't enough: every dispatch numbers its run from 1, so a job sent while
  // the driver is mid-run used to jump ahead of the stop they had already
  // picked up and were driving to. A started stop comes first, then older
  // runs before newer ones, then the run's own sequence.
  const activeSorted = useMemo<Job[]>(
    () =>
      [...(day?.active ?? [])].sort(
        (a, b) =>
          Number(b.status === "PICKED_UP") - Number(a.status === "PICKED_UP") ||
          new Date(a.assignedAt).getTime() - new Date(b.assignedAt).getTime() ||
          (a.sequence ?? 99) - (b.sequence ?? 99),
      ),
    [day],
  );
  const [viewIndex, setViewIndex] = useState(0);
  // Keep the viewed index in range as stops complete / new ones arrive.
  useEffect(() => {
    setViewIndex((i) => Math.min(Math.max(0, i), Math.max(0, activeSorted.length - 1)));
  }, [activeSorted.length]);

  const viewIdx = Math.min(viewIndex, Math.max(0, activeSorted.length - 1));
  const current = activeSorted[viewIdx] ?? null;
  const anyStarted = activeSorted.some((a) => a.status === "PICKED_UP");

  // Show the card whenever the run changes (a new dispatch arrives), and never
  // allow the map peek once any stop has been started.
  const firstActiveId = activeSorted[0]?.id ?? null;
  useEffect(() => {
    setMinimized(false);
  }, [firstActiveId]);
  useEffect(() => {
    if (anyStarted) setMinimized(false);
  }, [anyStarted]);

  // A stop that wasn't on the last poll is a fresh dispatch. The push already
  // rang if the app was in the background; in the foreground buzz the phone
  // and flash a banner too, because a driver glancing at a mounted phone may
  // not catch a silent screen change.
  const seenStopsRef = useRef<Set<string> | null>(null);
  const [newJobs, setNewJobs] = useState(0);
  useEffect(() => {
    if (!day) return;
    const ids = new Set(day.active.map((j) => j.id));
    const seen = seenStopsRef.current;
    seenStopsRef.current = ids;
    if (!seen) return; // first load after launch/sign-in — nothing is "new"
    const fresh = [...ids].filter((id) => !seen.has(id)).length;
    if (fresh > 0) {
      setNewJobs(fresh);
      Vibration.vibrate(Platform.OS === "android" ? [0, 350, 150, 350] : 400);
    }
  }, [day]);
  useEffect(() => {
    if (!tokens) seenStopsRef.current = null;
  }, [tokens]);

  // ── OTA updates ─────────────────────────────────────────────────────────────
  // expo-updates checks at cold launch by itself, but a driver keeps this app
  // open for a whole shift, so re-check on every foreground too. Download here;
  // the effect below decides when it is safe to restart into it.
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      downloadUpdateIfAvailable().then((ready) => {
        if (ready && !cancelled) setUpdateReady(true);
      });
    };
    check();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") check();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  // Restart into a staged update only when nothing is in flight: signed in and
  // sitting on the home screen, no dispatched stop, nothing open, no request
  // running. From there a reload is a blink — auth is in SecureStore and
  // presence is server-side, so the driver stays signed in and stays online —
  // but doing it mid-delivery, over a half-typed chat message, or through a
  // sign-in or the location disclosure is not worth the minutes it saves.
  useEffect(() => {
    if (!updateReady) return;
    const idle =
      !!tokens &&
      !current &&
      !manualJob &&
      !customerChatOrderId &&
      !overlay &&
      !ordersTab &&
      !showDisclosure &&
      !busy;
    if (!idle) return;
    const t = setTimeout(() => {
      applyDownloadedUpdate();
    }, 1_500);
    return () => clearTimeout(t);
  }, [
    updateReady,
    tokens,
    current,
    manualJob,
    customerChatOrderId,
    overlay,
    ordersTab,
    showDisclosure,
    busy,
  ]);

  if (!hydrated) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: C.bg }}>
        <ActivityIndicator color={C.text} />
      </View>
    );
  }

  function renderBody() {
    if (!tokens) return <LoginScreen onSignedIn={(t) => setTokens(t)} />;

    // Customer chat opened from a push tap.
    if (customerChatOrderId) {
      return (
        <ChatScreen
          key={`cust-${customerChatOrderId}`}
          title="Customer"
          subtitle="Delivery chat"
          mine="DRIVER"
          load={() => getCustomerChat(customerChatOrderId)}
          send={(t) => sendCustomerChat(customerChatOrderId, t)}
          onBack={() => setCustomerChatOrderId(null)}
        />
      );
    }

    // A job opened explicitly from a list (active/history) — read/act, then back.
    if (manualJob) {
      return (
        <JobScreen
          key={`manual-${manualJob.id}`}
          job={manualJob}
          total={activeSorted.length || 1}
          pos={pos}
          onChanged={refresh}
          onBack={() => setManualJob(null)}
        />
      );
    }

    if (overlay === "profile") {
      return (
        <ProfileScreen
          onBack={() => setOverlay(null)}
          onSignOut={() => {
            setOverlay(null);
            setTokens(null);
          }}
        />
      );
    }
    if (overlay === "cashup") return <CashUpScreen onBack={() => setOverlay(null)} />;
    if (overlay === "chat") {
      return (
        <ChatScreen
          title="Operator"
          subtitle="Dispatch chat"
          mine="DRIVER"
          load={getOperatorChat}
          send={sendOperatorChat}
          onBack={() => {
            setOverlay(null);
            setChatUnread(0);
            refresh();
          }}
        />
      );
    }
    if (ordersTab) {
      return (
        <OrdersScreen
          initialTab={ordersTab}
          onBack={() => setOrdersTab(null)}
          onOpenJob={(j) => {
            setOrdersTab(null);
            setManualJob(j);
          }}
        />
      );
    }

    // A dispatched/active stop takes over the screen until it's done. Swipe (or
    // the ‹ › arrows) moves between stops in a multi-drop run.
    if (current && !minimized) {
      return (
        <JobScreen
          key={current.id}
          job={current}
          total={activeSorted.length}
          pos={pos}
          onChanged={refresh}
          canMinimize={!anyStarted}
          onMinimize={() => setMinimized(true)}
          index={viewIdx}
          count={activeSorted.length}
          onPrev={() => setViewIndex((i) => Math.max(0, i - 1))}
          onNext={() => setViewIndex((i) => Math.min(activeSorted.length - 1, i + 1))}
        />
      );
    }

    return (
      <HomeScreen
        me={me}
        day={day}
        online={online}
        busy={busy}
        pos={pos}
        hasActiveJob={!!current}
        pushBlocked={pushBlocked}
        onToggleOnline={toggleOnline}
        onResumeJob={() => setMinimized(false)}
        onSignOut={() => setTokens(null)}
        onOpenProfile={() => setOverlay("profile")}
        onOpenOrders={(t) => setOrdersTab(t)}
        onOpenCashUp={() => setOverlay("cashup")}
        onOpenChat={() => setOverlay("chat")}
        chatUnread={chatUnread}
      />
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={["top"]}>
        <StatusBar style="light" />
        {renderBody()}
        <NewJobBanner count={newJobs} onDone={() => setNewJobs(0)} />
        <LocationDisclosure
          visible={showDisclosure}
          onAccept={acceptDisclosure}
          onDecline={declineDisclosure}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
