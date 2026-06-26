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

const PANEL_W = Math.min(330, Dimensions.get("window").width * 0.85);

export type OrdersTab = "active" | "delivered" | "history";

// Hamburger side panel — a menu that opens the orders / cash-up / profile
// screens. Counts come from the cached my-day payload.
export function Drawer({
  open,
  onClose,
  me,
  day,
  onOpenOrders,
  onOpenCashUp,
  onOpenProfile,
  onSignOut,
}: {
  open: boolean;
  onClose: () => void;
  me: DriverProfile | null;
  day: MyDay | null;
  onOpenOrders: (tab: OrdersTab) => void;
  onOpenCashUp: () => void;
  onOpenProfile: () => void;
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

  const activeCount = day?.active?.length ?? 0;
  const deliveredCount = (day?.history ?? []).filter((j) => j.status === "DELIVERED").length;

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

        <Item label="Active orders" badge={activeCount} onPress={() => onOpenOrders("active")} />
        <Item label="Delivered" badge={deliveredCount} onPress={() => onOpenOrders("delivered")} />
        <Item label="History" onPress={() => onOpenOrders("history")} />
        <Item label="Cash up" onPress={onOpenCashUp} />

        <View style={{ flex: 1 }} />

        <Item label="Profile & account" onPress={onOpenProfile} />
        <Pressable style={styles.logout} onPress={onSignOut}>
          <Text style={styles.logoutText}>Log out</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

function Item({ label, badge, onPress }: { label: string; badge?: number; onPress: () => void }) {
  return (
    <Pressable style={styles.item} onPress={onPress}>
      <Text style={styles.itemText}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {badge != null && badge > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        )}
        <Text style={styles.chev}>›</Text>
      </View>
    </Pressable>
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
    paddingHorizontal: 18,
    paddingBottom: 28,
  },
  header: { borderBottomWidth: 1, borderBottomColor: "#1e293b", paddingBottom: 16, marginBottom: 8 },
  name: { color: "#fff", fontSize: 20, fontWeight: "800" },
  status: { fontSize: 13, fontWeight: "700", marginTop: 4 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },
  itemText: { color: "#e2e8f0", fontSize: 16, fontWeight: "600" },
  badge: { backgroundColor: "#f97316", borderRadius: 999, minWidth: 22, paddingHorizontal: 6, paddingVertical: 2, alignItems: "center" },
  badgeText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  chev: { color: "#64748b", fontSize: 20, fontWeight: "700" },
  logout: { backgroundColor: "#1e293b", borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 8 },
  logoutText: { color: "#f87171", fontWeight: "800", fontSize: 15 },
});
