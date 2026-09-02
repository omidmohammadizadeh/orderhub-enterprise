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
import { ActivityIndicator, Alert, AppState, Platform, View } from "react-native";
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
  registerForPush,
  setupJobCategory,
} from "@/services/notifications";
import { LoginScreen } from "@/screens/LoginScreen";
import { HomeScreen } from "@/screens/HomeScreen";
import { JobScreen } from "@/screens/JobScreen";
import { ProfileScreen } from "@/screens/ProfileScreen";
import { OrdersScreen } from "@/screens/OrdersScreen";
import { CashUpScreen } from "@/screens/CashUpScreen";
import { LocationDisclosure } from "@/components/LocationDisclosure";
import type { OrdersTab } from "@/components/Drawer";

export type LatLng = { latitude: number; longitude: number };

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
  const [showDisclosure, setShowDisclosure] = useState(false);
  useEffect(() => {
    if (Platform.OS === "ios") return; // no disclosure gate on iOS
    SecureStore.getItemAsync(LOCATION_CONSENT_KEY)
      .then((v) => setLocationConsent(v === "1"))
      .catch(() => {});
  }, []);

  // Live driver position — owned here so it survives screen changes.
  const [pos, setPos] = useState<LatLng | null>(null);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const lastPingRef = useRef(0);

  const online = me?.presence?.status === "ONLINE" || me?.presence?.status === "ON_JOB";

  useEffect(() => {
    configureGoogleSignIn();
  }, []);

  // Clear the app-icon badge + tray notifications on launch and whenever the
  // app returns to the foreground.
  useEffect(() => {
    clearNotificationBadges();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") clearNotificationBadges();
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
    registerForPush();
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
      setPos({ latitude: cur.coords.latitude, longitude: cur.coords.longitude });
    } catch {
      /* ignore */
    }
    watchRef.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 20 },
      (loc) => {
        setPos({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
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
  const reconciledRef = useRef(false);
  useEffect(() => {
    if (reconciledRef.current || !online) return;
    reconciledRef.current = true;
    (async () => {
      try {
        const fg = await Location.getForegroundPermissionsAsync();
        const deviceReady =
          fg.status === "granted" &&
          (Platform.OS === "ios" || locationConsent);
        if (!deviceReady) await runOnline(false);
      } catch {
        /* leave presence as-is */
      }
    })();
  }, [online, locationConsent, runOnline]);

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
    runOnline(true);
  }

  // Android-only: Google Play's prominent-disclosure policy requires a
  // decline path. On iOS the modal has no exit affordance (Guideline
  // 5.1.1(iv)) so this never fires there.
  function declineDisclosure() {
    setShowDisclosure(false);
    // Being online requires location consent — if they decline, go offline.
    if (online) runOnline(false);
  }

  // ── Active-job routing ──────────────────────────────────────────────────────
  // Stops ordered by their multi-drop sequence; the driver can swipe between them.
  const activeSorted = useMemo<Job[]>(
    () => [...(day?.active ?? [])].sort((a, b) => (a.sequence ?? 99) - (b.sequence ?? 99)),
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

  if (!hydrated) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0F172A" }}>
        <ActivityIndicator color="#fff" />
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
      <SafeAreaView style={{ flex: 1, backgroundColor: "#0F172A" }} edges={["top"]}>
        <StatusBar style="light" />
        {renderBody()}
        <LocationDisclosure
          visible={showDisclosure}
          onAccept={acceptDisclosure}
          onDecline={declineDisclosure}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
