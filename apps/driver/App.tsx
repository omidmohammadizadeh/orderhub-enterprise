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
import { ActivityIndicator, Alert, AppState, View } from "react-native";
import * as Location from "expo-location";
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

  // Prominent location-disclosure gate (shown before the first permission prompt).
  const [locationConsent, setLocationConsent] = useState(false);
  const [showDisclosure, setShowDisclosure] = useState(false);
  useEffect(() => {
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
    try {
      const [m, d] = await Promise.all([getMe(), getMyDay()]);
      setMe(m);
      setDay(d);
    } catch {
      // transient — keep showing what we have
    }
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
    const fg = await Location.requestForegroundPermissionsAsync();
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

  // If the driver is online (e.g. the server auto-resumed them from a prior
  // session) but hasn't accepted the disclosure yet, show it before any location
  // starts. Transition-guarded so declining (→ offline) can't re-open it in a loop.
  const prevOnlineRef = useRef(false);
  useEffect(() => {
    const was = prevOnlineRef.current;
    prevOnlineRef.current = online;
    if (online && !was && !locationConsent) setShowDisclosure(true);
  }, [online, locationConsent]);

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

  // Going online starts location sharing — show the prominent disclosure first
  // (Google Play policy) before any system location prompt fires.
  const toggleOnline = useCallback(
    async (next: boolean) => {
      if (next && !locationConsent) {
        setShowDisclosure(true);
        return;
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
    runOnline(true);
  }

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
