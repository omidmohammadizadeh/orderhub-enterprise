import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";
import { DriverProfile, MyDay } from "@/services/auth";
import { Drawer } from "@/components/Drawer";
import type { LatLng } from "../../App";

const UK_REGION = {
  latitude: 52.4814,
  longitude: -1.8998,
  latitudeDelta: 0.5,
  longitudeDelta: 0.5,
};

// Presentational hub: live map + online toggle + drawer menu. All data, the
// online status and the location watch are owned by App.
export function HomeScreen({
  me,
  day,
  online,
  busy,
  pos,
  hasActiveJob,
  pushBlocked,
  onToggleOnline,
  onResumeJob,
  onSignOut,
  onOpenProfile,
  onOpenOrders,
  onOpenCashUp,
  onOpenChat,
  chatUnread,
}: {
  me: DriverProfile | null;
  day: MyDay | null;
  online: boolean;
  busy: boolean;
  pos: LatLng | null;
  hasActiveJob: boolean;
  pushBlocked: boolean;
  onToggleOnline: (next: boolean) => void;
  onResumeJob: () => void;
  onSignOut: () => void;
  onOpenProfile: () => void;
  onOpenOrders: (tab: "active" | "delivered" | "history") => void;
  onOpenCashUp: () => void;
  onOpenChat: () => void;
  chatUnread?: number;
}) {
  const [drawer, setDrawer] = useState(false);
  const mapRef = useRef<MapView | null>(null);

  // Follow the driver as their position updates.
  useEffect(() => {
    if (pos) mapRef.current?.animateCamera({ center: pos }, { duration: 500 });
  }, [pos]);

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
            {me?.presence?.status === "ON_JOB" ? "On a job" : online ? "Online" : "Offline"}
          </Text>
          {busy ? (
            <ActivityIndicator />
          ) : (
            <Switch value={online} onValueChange={onToggleOnline} disabled={hasActiveJob} />
          )}
        </View>
      </View>

      {/* Notifications are off on this phone. iOS asks once and never again,
          so a driver who declined gets no job alerts at all and has no way to
          know why — the shop dispatches, the phone stays silent, and it looks
          like the app is broken for that one person. Say so, and open the
          settings page that can undo it. */}
      {pushBlocked && (
        <Pressable
          style={styles.pushWarn}
          onPress={() => Linking.openSettings()}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.pushWarnTitle}>Job alerts are turned off</Text>
            <Text style={styles.pushWarnSub}>
              You won&apos;t be told when a delivery is sent to you. Tap to turn
              notifications on.
            </Text>
          </View>
          <Text style={styles.pushWarnOpen}>Settings ›</Text>
        </Pressable>
      )}

      {/* Resume the active delivery (shown only when the driver peeked the map) */}
      {hasActiveJob && (
        <Pressable style={styles.resumeCard} onPress={onResumeJob}>
          <View style={{ flex: 1 }}>
            <Text style={styles.resumeTitle}>Delivery in progress</Text>
            <Text style={styles.resumeSub}>Tap to resume your current stop</Text>
          </View>
          <Text style={styles.resumeOpen}>Resume ›</Text>
        </Pressable>
      )}

      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        me={me}
        day={day}
        chatUnread={chatUnread}
        onSignOut={onSignOut}
        onOpenChat={() => {
          setDrawer(false);
          onOpenChat();
        }}
        onOpenProfile={() => {
          setDrawer(false);
          onOpenProfile();
        }}
        onOpenOrders={(tab) => {
          setDrawer(false);
          onOpenOrders(tab);
        }}
        onOpenCashUp={() => {
          setDrawer(false);
          onOpenCashUp();
        }}
      />
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
  pushWarn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 12,
    marginTop: 10,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#7f1d1d",
  },
  pushWarnTitle: { color: "#fff", fontSize: 14, fontWeight: "700" },
  pushWarnSub: { color: "#fecaca", fontSize: 12, marginTop: 2 },
  pushWarnOpen: { color: "#fff", fontSize: 13, fontWeight: "700" },
  onlineWrap: { flexDirection: "row", alignItems: "center", gap: 8 },
  onlineLabel: { fontSize: 13, fontWeight: "700" },
  resumeCard: {
    position: "absolute",
    left: 14,
    right: 14,
    bottom: 28,
    backgroundColor: "#f97316",
    borderRadius: 14,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  resumeTitle: { fontWeight: "800", color: "#fff", fontSize: 15 },
  resumeSub: { color: "#fff", opacity: 0.9, fontSize: 13, marginTop: 2 },
  resumeOpen: { color: "#fff", fontWeight: "800" },
});
