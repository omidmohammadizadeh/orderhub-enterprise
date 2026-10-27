import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Animated, Easing, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import MapView from "react-native-maps";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DriverProfile, MyDay } from "@/services/auth";
import { Drawer } from "@/components/Drawer";
import { DriverMarker } from "@/components/MapMarkers";
import { Icon, Pulse, RoundButton, StatusDot } from "@/components/ui";
import { MapPlaceholder } from "@/components/MapPlaceholder";
import { requestAllPermissions } from "@/services/notifications";
import { C, R, MAP_AVAILABLE, mapProps, money, shadow } from "@/theme";
import type { LatLng } from "../../App";

const UK_REGION = {
  latitude: 52.4814,
  longitude: -1.8998,
  latitudeDelta: 0.5,
  longitudeDelta: 0.5,
};

const STREET_DELTA = { latitudeDelta: 0.012, longitudeDelta: 0.012 };

// Presentational hub: live map + go-online control + drawer menu. All data, the
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
  const insets = useSafeAreaInsets();
  const [drawer, setDrawer] = useState(false);
  const [follow, setFollow] = useState(true);
  const mapRef = useRef<MapView | null>(null);
  const onJob = me?.presence?.status === "ON_JOB";
  const cash = day?.cashUp;
  const waiting = Math.max(1, day?.active?.length ?? 0);

  // Follow the driver as their position updates — until they pan away to look
  // at something; the locate button snaps back.
  // A region, not a camera zoom: Apple Maps ignores `zoom` (it wants an
  // altitude), so animateToRegion is the one call that frames both engines.
  useEffect(() => {
    if (pos && follow) mapRef.current?.animateToRegion({ ...pos, ...STREET_DELTA }, 600);
  }, [pos, follow]);

  function recenter() {
    setFollow(true);
    if (pos) mapRef.current?.animateToRegion({ ...pos, ...STREET_DELTA }, 500);
  }

  async function fixPermissions() {
    setDrawer(false);
    const r = await requestAllPermissions();
    if (!r.needsSettings) {
      Alert.alert("All set", "Job alerts and location are on. You'll be told the moment a delivery is sent to you.");
      return;
    }
    // iOS spends its one permission dialog on the first ask. Once that has been
    // declined nothing in the app can bring it back, so say plainly what is off
    // and take them to the only screen that fixes it.
    const off = [!r.notifications ? "job alerts" : null, !r.location ? "location" : null].filter(Boolean).join(" and ");
    Alert.alert(
      "Finish in Settings",
      `Your phone still has ${off} switched off, and only the Settings app can turn ${
        off.includes("and") ? "them" : "it"
      } back on.`,
      [
        { text: "Not now", style: "cancel" },
        { text: "Open Settings", onPress: () => Linking.openSettings() },
      ],
    );
  }

  return (
    <View style={styles.container}>
      {MAP_AVAILABLE ? (
        <MapView
          ref={mapRef}
          {...mapProps}
          style={StyleSheet.absoluteFill}
          initialRegion={pos ? { ...pos, latitudeDelta: 0.02, longitudeDelta: 0.02 } : UK_REGION}
          showsMyLocationButton={false}
          showsUserLocation={false}
          showsCompass={false}
          toolbarEnabled={false}
          onPanDrag={() => follow && setFollow(false)}
        >
          {pos && <DriverMarker coordinate={pos} heading={pos.heading} />}
        </MapView>
      ) : (
        <MapPlaceholder />
      )}

      {/* Top row: menu · today's earnings · chat */}
      <View style={[styles.topRow, { top: 10 }]} pointerEvents="box-none">
        <RoundButton icon="menu" onPress={() => setDrawer(true)} accessibilityLabel="Menu" />
        <Pressable style={(s) => [styles.earnPill, shadow, s.pressed && { opacity: 0.85 }]} onPress={onOpenCashUp}>
          <Text style={styles.earnPillLabel}>TODAY</Text>
          <Text style={styles.earnPillValue}>{money(cash?.earning)}</Text>
        </Pressable>
        <RoundButton icon="chatbubble-ellipses" onPress={onOpenChat} badge={chatUnread} accessibilityLabel="Chat with operator" />
      </View>

      {/* Notifications are off on this phone. iOS asks once and never again, so
          a driver who declined gets no job alerts and has no way to know why.
          Say so, and open the settings page that can undo it. */}
      {pushBlocked && (
        <Pressable style={[styles.pushWarn, shadow]} onPress={() => Linking.openSettings()}>
          <View style={styles.pushWarnIcon}>
            <Icon name="notifications-off" size={18} color={C.danger} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.pushWarnTitle}>Job alerts are turned off</Text>
            <Text style={styles.pushWarnSub}>You won&apos;t be told when a delivery is sent to you.</Text>
          </View>
          <Text style={styles.pushWarnOpen}>Fix</Text>
        </Pressable>
      )}

      {/* Bottom: locate, GO button and the status sheet */}
      <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, 14) }]} pointerEvents="box-none">
        <View style={styles.fabRow} pointerEvents="box-none">
          <View style={{ width: 48 }} />
          {!online && !hasActiveJob ? (
            <GoButton busy={busy} onPress={() => onToggleOnline(true)} />
          ) : (
            <View />
          )}
          <RoundButton icon="locate" onPress={recenter} disabled={!pos} accessibilityLabel="Centre on me" />
        </View>

        {hasActiveJob ? (
          <Pressable style={(s) => [styles.sheet, styles.resume, shadow, s.pressed && { opacity: 0.9 }]} onPress={onResumeJob}>
            <View style={styles.resumeIcon}>
              <Icon name="cube" size={22} color={C.onAccent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.sheetTitle}>
                {waiting === 1 ? "1 delivery waiting" : `${waiting} deliveries waiting`}
              </Text>
              <Text style={styles.sheetSub}>Tap to open your next stop</Text>
            </View>
            <Icon name="chevron-forward" size={22} color={C.go} />
          </Pressable>
        ) : (
          <View style={[styles.sheet, shadow]}>
            <View style={styles.sheetHead}>
              <StatusDot color={online ? C.go : C.textMute} live={online} />
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetTitle}>
                  {onJob ? "On a job" : online ? "You're online" : "You're offline"}
                </Text>
                <Text style={styles.sheetSub}>
                  {online ? "Waiting for dispatch — keep the app open" : "Go online to start receiving deliveries"}
                </Text>
              </View>
              {online &&
                (busy ? (
                  <ActivityIndicator color={C.textDim} />
                ) : (
                  <Pressable
                    onPress={() => onToggleOnline(false)}
                    style={(s) => [styles.offBtn, s.pressed && { opacity: 0.7 }]}
                    accessibilityLabel="Go offline"
                  >
                    <Icon name="power" size={16} color={C.danger} />
                    <Text style={styles.offBtnText}>Stop</Text>
                  </Pressable>
                ))}
            </View>
            {online && <ScanBar />}
            <View style={styles.stats}>
              <Stat label="Deliveries" value={String(cash?.deliveries ?? 0)} />
              <View style={styles.statDivider} />
              <Stat label="Collected" value={money(cash?.total)} />
              <View style={styles.statDivider} />
              <Stat label="Earned" value={money(cash?.earning)} accent={C.go} />
            </View>
          </View>
        )}
      </View>

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
        onFixPermissions={fixPermissions}
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

function GoButton({ busy, onPress }: { busy: boolean; onPress: () => void }) {
  return (
    <View style={styles.goWrap}>
      <Pulse color={C.go} size={124} />
      <Pressable
        onPress={onPress}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Go online"
        style={(s) => [styles.go, shadow, s.pressed && { transform: [{ scale: 0.95 }] }]}
      >
        {busy ? <ActivityIndicator color={C.onAccent} /> : <Text style={styles.goText}>GO</Text>}
      </Pressable>
    </View>
  );
}

// A thin light sweeping across the sheet while the driver is online and idle —
// the "searching" cue, without a spinner that reads as "loading".
function ScanBar() {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(v, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <View style={styles.scanTrack}>
      <Animated.View
        style={[
          styles.scanBeam,
          { transform: [{ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [-120, 360] }) }] },
        ]}
      />
    </View>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center" }}>
      <Text style={[styles.statValue, accent ? { color: accent } : null]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  topRow: {
    position: "absolute",
    left: 14,
    right: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  earnPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.glass,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: R.pill,
    paddingHorizontal: 18,
    height: 48,
  },
  earnPillLabel: { color: C.textMute, fontSize: 11, fontWeight: "800", letterSpacing: 1.2 },
  earnPillValue: { color: C.text, fontSize: 20, fontWeight: "900", fontVariant: ["tabular-nums"] },
  pushWarn: {
    position: "absolute",
    top: 70,
    left: 14,
    right: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: R.md,
    backgroundColor: "#2A1416",
    borderWidth: 1,
    borderColor: "rgba(255,77,79,0.4)",
  },
  pushWarnIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,77,79,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  pushWarnTitle: { color: C.text, fontSize: 14, fontWeight: "800" },
  pushWarnSub: { color: "#F2A7A8", fontSize: 12, marginTop: 2 },
  pushWarnOpen: { color: C.danger, fontSize: 14, fontWeight: "900" },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 12 },
  fabRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 2,
    marginBottom: 12,
  },
  goWrap: { width: 124, height: 124, alignItems: "center", justifyContent: "center" },
  go: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: C.go,
    borderWidth: 5,
    borderColor: "rgba(255,255,255,0.9)",
    alignItems: "center",
    justifyContent: "center",
  },
  goText: { color: C.onAccent, fontSize: 28, fontWeight: "900", letterSpacing: 1 },
  sheet: {
    backgroundColor: C.surface,
    borderRadius: R.lg,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
  },
  sheetHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  sheetTitle: { color: C.text, fontSize: 18, fontWeight: "900" },
  sheetSub: { color: C.textDim, fontSize: 13, marginTop: 2 },
  offBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    height: 38,
    borderRadius: R.pill,
    backgroundColor: "rgba(255,77,79,0.12)",
    borderWidth: 1,
    borderColor: "rgba(255,77,79,0.35)",
  },
  offBtnText: { color: C.danger, fontWeight: "800", fontSize: 14 },
  scanTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: C.surface3,
    overflow: "hidden",
    marginTop: 14,
  },
  scanBeam: { width: 120, height: 3, borderRadius: 2, backgroundColor: C.go },
  stats: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  statDivider: { width: StyleSheet.hairlineWidth, height: 28, backgroundColor: C.border },
  statValue: { color: C.text, fontSize: 18, fontWeight: "900", fontVariant: ["tabular-nums"] },
  statLabel: { color: C.textMute, fontSize: 11, fontWeight: "700", marginTop: 2, letterSpacing: 0.4 },
  resume: { flexDirection: "row", alignItems: "center", gap: 12, borderColor: "rgba(30,214,127,0.45)" },
  resumeIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: C.go,
    alignItems: "center",
    justifyContent: "center",
  },
});
