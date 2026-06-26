import { useEffect, useRef } from "react";
import {
  Animated,
  Dimensions,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { DriverProfile, MyDay } from "@/services/auth";

const PANEL_W = Math.min(320, Dimensions.get("window").width * 0.82);

// Hamburger side panel: account + My Deliveries cash-up + logout.
export function Drawer({
  open,
  onClose,
  me,
  day,
  onSignOut,
}: {
  open: boolean;
  onClose: () => void;
  me: DriverProfile | null;
  day: MyDay | null;
  onSignOut: () => void;
}) {
  const x = useRef(new Animated.Value(-PANEL_W)).current;

  useEffect(() => {
    Animated.timing(x, {
      toValue: open ? 0 : -PANEL_W,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [open, x]);

  const cash = day?.cashUp;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? "auto" : "none"}>
      {open && <Pressable style={styles.backdrop} onPress={onClose} />}
      <Animated.View style={[styles.panel, { transform: [{ translateX: x }] }]}>
        <View style={styles.header}>
          <Text style={styles.name}>
            {me ? `${me.firstName} ${me.lastName}` : "Driver"}
          </Text>
          <Text
            style={[
              styles.status,
              { color: me?.presence?.status === "OFFLINE" || !me?.presence ? "#94a3b8" : "#16a34a" },
            ]}
          >
            {me?.presence?.status === "ON_JOB"
              ? "On a job"
              : me?.presence?.status === "ONLINE"
                ? "Online"
                : "Offline"}
          </Text>
        </View>

        <Text style={styles.section}>My deliveries (today)</Text>
        <View style={styles.cashGrid}>
          <Cash label="Deliveries" value={`${cash?.deliveries ?? 0}`} />
          <Cash label="Cash" value={`£${cash?.cashTotal ?? "0.00"}`} />
          <Cash label="Card" value={`£${cash?.cardTotal ?? "0.00"}`} />
          <Cash label="Total" value={`£${cash?.total ?? "0.00"}`} big />
        </View>

        <View style={{ flex: 1 }} />

        <Pressable style={styles.logout} onPress={onSignOut}>
          <Text style={styles.logoutText}>Log out</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

function Cash({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <View style={[styles.cashCell, big && styles.cashCellBig]}>
      <Text style={[styles.cashValue, big && { fontSize: 22 }]}>{value}</Text>
      <Text style={styles.cashLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.4)" },
  panel: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: PANEL_W,
    backgroundColor: "#0F172A",
    paddingTop: 64,
    paddingHorizontal: 20,
    paddingBottom: 32,
  },
  header: { borderBottomWidth: 1, borderBottomColor: "#1e293b", paddingBottom: 16 },
  name: { color: "#fff", fontSize: 20, fontWeight: "800" },
  status: { fontSize: 13, fontWeight: "700", marginTop: 4 },
  section: { color: "#94a3b8", fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginTop: 24, marginBottom: 10 },
  cashGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  cashCell: { backgroundColor: "#1e293b", borderRadius: 12, padding: 14, width: "47%" },
  cashCellBig: { width: "100%", backgroundColor: "#f97316" },
  cashValue: { color: "#fff", fontSize: 18, fontWeight: "800" },
  cashLabel: { color: "#cbd5e1", fontSize: 12, marginTop: 4 },
  logout: { backgroundColor: "#1e293b", borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  logoutText: { color: "#f87171", fontWeight: "800", fontSize: 15 },
});
