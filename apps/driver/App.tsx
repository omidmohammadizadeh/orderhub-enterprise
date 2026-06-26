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
import { ActivityIndicator, Alert, View } from "react-native";
import * as Location from "expo-location";

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
} from "@/services/auth";
import { configureGoogleSignIn } from "@/services/google";
import {
  pingNow,
  startLocationUpdates,
  stopLocationUpdates,
} from "@/services/location";
import {
  attachJobResponseHandler,
  registerForPush,
  setupJobCategory,
} from "@/services/notifications";
import { LoginScreen } from "@/screens/LoginScreen";
import { HomeScreen } from "@/screens/HomeScreen";
import { JobScreen } from "@/screens/JobScreen";
import { ProfileScreen } from "@/screens/ProfileScreen";
import { OrdersScreen } from "@/screens/OrdersScreen";
import { CashUpScreen } from "@/screens/CashUpScreen";
import type { OrdersTab } from "@/components/Drawer";

export type LatLng = { latitude: number; longitude: number };

export default function App() {
  const { tokens, hydrated, setTokens } = useAuth();

  const [me, setMe] = useState<DriverProfile | null>(null);
  const [day, setDay] = useState<MyDay | null>(null);
  const [busy, setBusy] = useState(false);

  // Navigation overlays (opened from the drawer menu).
  const [overlay, setOverlay] = useState<null | "profile" | "cashup">(null);
  const [ordersTab, setOrdersTab] = useState<OrdersTab | null>(null);
  const [manualJob, setManualJob] = useState<Job | null>(null); // opened from a list
  const [minimized, setMinimized] = useState(false); // peek the map while a job is ASSIGNED (not started)

  // Live driver position — owned here so it survives screen changes.
  const [pos, setPos] = useState<LatLng | null>(null);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const lastPingRef = useRef(0);

  const online = me?.presence?.status === "ONLINE" || me?.presence?.status === "ON_JOB";

  useEffect(() => {
    configureGoogleSignIn();
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [m, d] = await Promise.all([getMe(), getMyDay()]);
      setMe(m);
      setDay(d);
    } catch {
      // transient — keep showing what we have
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
    const detach = attachJobResponseHandler(() => refresh());
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

  useEffect(() => {
    if (online) {
      startWatch();
      startLocationUpdates().catch(() => {});
    } else {
      stopWatch();
      stopLocationUpdates().catch(() => {});
    }
    return () => {
      // App-level effect — only tears down on unmount.
    };
  }, [online, startWatch, stopWatch]);

  const toggleOnline = useCallback(
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

  // ── Active-job routing ──────────────────────────────────────────────────────
  const active = day?.active ?? [];
  const current = useMemo<Job | null>(() => {
    // An in-progress stop (already picked up) wins, otherwise the lowest sequence.
    const started = active.find((a) => a.status === "PICKED_UP");
    if (started) return started;
    return [...active].sort((a, b) => (a.sequence ?? 99) - (b.sequence ?? 99))[0] ?? null;
  }, [active]);

  // Show the card whenever the current stop changes (a new dispatch arrives), and
  // never allow the map peek once a stop has been started.
  const currentId = current?.id ?? null;
  const currentStarted = current?.status === "PICKED_UP";
  useEffect(() => {
    setMinimized(false);
  }, [currentId]);
  useEffect(() => {
    if (currentStarted) setMinimized(false);
  }, [currentStarted]);

  if (!hydrated) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0F172A" }}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  function renderBody() {
    if (!tokens) return <LoginScreen onSignedIn={(t) => setTokens(t)} />;

    // A job opened explicitly from a list (active/history) — read/act, then back.
    if (manualJob) {
      return (
        <JobScreen
          key={`manual-${manualJob.id}`}
          job={manualJob}
          total={active.length}
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

    // A dispatched/active stop takes over the screen until it's done.
    if (current && !minimized) {
      return (
        <JobScreen
          key={current.id}
          job={current}
          total={active.length}
          pos={pos}
          onChanged={refresh}
          canMinimize={!currentStarted}
          onMinimize={() => setMinimized(true)}
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
      />
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#0F172A" }} edges={["top"]}>
        <StatusBar style="light" />
        {renderBody()}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
