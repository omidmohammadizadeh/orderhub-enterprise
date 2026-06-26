import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import {
  DriverProfile,
  Job,
  LocationSummary,
  MyDay,
  getLocations,
  getMe,
  getMyDay,
  goOffline,
  goOnline,
} from "@/services/auth";
import { pingNow, startLocationUpdates, stopLocationUpdates } from "@/services/location";
import { Drawer } from "@/components/Drawer";

const UK_REGION = {
  latitude: 52.4814,
  longitude: -1.8998,
  latitudeDelta: 0.5,
  longitudeDelta: 0.5,
};

export function HomeScreen({
  onOpenJob,
  onSignOut,
}: {
  onOpenJob: (job: Job) => void;
  onSignOut: () => void;
}) {
  const [me, setMe] = useState<DriverProfile | null>(null);
  const [day, setDay] = useState<MyDay | null>(null);
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [pos, setPos] = useState<{ latitude: number; longitude: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const mapRef = useRef<MapView | null>(null);
  const watchRef = useRef<Location.LocationSubscription | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [m, d] = await Promise.all([getMe(), getMyDay()]);
      setMe(m);
      setDay(d);
      const status = m.presence?.status;
      setOnline(status === "ONLINE" || status === "ON_JOB");
      if (m.presence?.locationId) setLocationId(m.presence.locationId);
    } catch {
      // transient
    }
  }, []);

  // Initial position + data.
  useEffect(() => {
    (async () => {
      try {
        const locs = await getLocations();
        setLocations(locs);
        if (locs.length >= 1) setLocationId((prev) => prev ?? locs[0].id);
      } catch {
        /* ignore */
      }
      try {
        const fg = await Location.requestForegroundPermissionsAsync();
        if (fg.status === "granted") {
          const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          const p = { latitude: cur.coords.latitude, longitude: cur.coords.longitude };
          setPos(p);
          mapRef.current?.animateToRegion({ ...p, latitudeDelta: 0.02, longitudeDelta: 0.02 }, 600);
        }
      } catch {
        /* ignore */
      }
      await refresh();
    })();
    const t = setInterval(refresh, 10_000);
    return () => {
      clearInterval(t);
      watchRef.current?.remove();
    };
  }, [refresh]);

  async function startWatch() {
    if (watchRef.current) return;
    watchRef.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 20 },
      (loc) => {
        const p = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
        setPos(p);
        mapRef.current?.animateCamera({ center: p }, { duration: 500 });
      },
    );
  }
  function stopWatch() {
    watchRef.current?.remove();
    watchRef.current = null;
  }

  async function toggleOnline(next: boolean) {
    if (next && !locationId) {
      Alert.alert("No location", "No delivery location is available for your account.");
      return;
    }
    setBusy(true);
    try {
      if (next) {
        await goOnline(locationId!);
        await startLocationUpdates();
        await pingNow();
        await startWatch();
        setOnline(true);
      } else {
        await goOffline();
        await stopLocationUpdates();
        stopWatch();
        setOnline(false);
      }
      await refresh();
    } catch (err) {
      Alert.alert("Error", (err as Error)?.message ?? "Try again");
    } finally {
      setBusy(false);
    }
  }

  const active = day?.active?.[0] ?? null;

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={StyleSheet.absoluteFill}
        initialRegion={pos ? { ...pos, latitudeDelta: 0.02, longitudeDelta: 0.02 } : UK_REGION}
        showsMyLocationButton={false}
        showsUserLocation={false}
      >
        {pos && (
          <Marker coordinate={pos} title="You" anchor={{ x: 0.5, y: 0.5 }}>
            <View style={styles.carBadge}>
              <Text style={{ fontSize: 20 }}>🚗</Text>
            </View>
          </Marker>
        )}
      </MapView>

      {/* Top bar */}
      <View style={styles.topbar}>
        <Pressable onPress={() => setDrawer(true)} hitSlop={12} style={styles.iconBtn}>
          <View style={styles.bar} />
          <View style={styles.bar} />
          <View style={styles.bar} />
        </Pressable>
        <Text style={styles.logo}>Order Hub Driver</Text>
        <View style={styles.onlineWrap}>
          <Text style={[styles.onlineLabel, { color: online ? "#16a34a" : "#94a3b8" }]}>
            {online ? "Online" : "Offline"}
          </Text>
          {busy ? <ActivityIndicator /> : <Switch value={online} onValueChange={toggleOnline} />}
        </View>
      </View>

      {/* Active delivery card */}
      {active && (
        <Pressable style={styles.jobCard} onPress={() => onOpenJob(active)}>
          <View style={{ flex: 1 }}>
            <Text style={styles.jobTitle}>
              #{active.order.displayId ?? active.order.orderNumber ?? active.order.id.slice(-5)} ·{" "}
              {active.order.customerName ?? "Customer"}
            </Text>
            <Text style={styles.jobAddr} numberOfLines={1}>
              {[active.order.addressLine1, active.order.city, active.order.postcode]
                .filter(Boolean)
                .join(", ") || "No address"}
            </Text>
          </View>
          <Text style={styles.jobOpen}>Open ›</Text>
        </Pressable>
      )}

      {/* Chat FAB */}
      <Pressable
        style={styles.chatFab}
        onPress={() =>
          Alert.alert("Chat", "Operator chat is coming in the next update.")
        }
      >
        <Text style={{ fontSize: 22 }}>💬</Text>
      </Pressable>

      <Drawer open={drawer} onClose={() => setDrawer(false)} me={me} day={day} onSignOut={onSignOut} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#e2e8f0" },
  carBadge: {
    backgroundColor: "#fff",
    borderRadius: 22,
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#2563eb",
  },
  topbar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 50,
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: "rgba(15,23,42,0.92)",
  },
  iconBtn: { width: 28, gap: 5, paddingVertical: 4 },
  bar: { height: 2.5, borderRadius: 2, backgroundColor: "#fff" },
  logo: { color: "#fff", fontSize: 16, fontWeight: "800" },
  onlineWrap: { flexDirection: "row", alignItems: "center", gap: 8 },
  onlineLabel: { fontSize: 13, fontWeight: "700" },
  jobCard: {
    position: "absolute",
    left: 14,
    right: 14,
    bottom: 28,
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  jobTitle: { fontWeight: "800", color: "#0F172A", fontSize: 15 },
  jobAddr: { color: "#64748b", fontSize: 13, marginTop: 3 },
  jobOpen: { color: "#f97316", fontWeight: "800" },
  chatFab: {
    position: "absolute",
    right: 18,
    bottom: 110,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#2563eb",
    alignItems: "center",
    justifyContent: "center",
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
});
