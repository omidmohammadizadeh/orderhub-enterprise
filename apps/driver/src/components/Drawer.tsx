import { useEffect, useRef } from "react";
import { Animated, Dimensions, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DriverProfile, MyDay } from "@/services/auth";
import { C, R, initials, money } from "@/theme";
import { Icon, IconName, StatusDot } from "@/components/ui";

const PANEL_W = Math.min(340, Dimensions.get("window").width * 0.86);

export type OrdersTab = "active" | "delivered" | "history";

// Hamburger side panel — a menu that opens the orders / cash-up / profile
// screens. Counts come from the cached my-day payload.
export function Drawer({
  open,
  onClose,
  me,
  day,
  chatUnread,
  onOpenOrders,
  onOpenCashUp,
  onOpenProfile,
  onFixPermissions,
  onOpenChat,
  onSignOut,
}: {
  open: boolean;
  onClose: () => void;
  me: DriverProfile | null;
  day: MyDay | null;
  chatUnread?: number;
  onOpenOrders: (tab: OrdersTab) => void;
  onOpenCashUp: () => void;
  onOpenProfile: () => void;
  onFixPermissions: () => void;
  onOpenChat: () => void;
  onSignOut: () => void;
}) {
  const insets = useSafeAreaInsets();
  const x = useRef(new Animated.Value(-PANEL_W)).current;
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(x, { toValue: open ? 0 : -PANEL_W, duration: 240, useNativeDriver: true }),
      Animated.timing(fade, { toValue: open ? 1 : 0, duration: 240, useNativeDriver: true }),
    ]).start();
  }, [open, x, fade]);

  const activeCount = day?.active?.length ?? 0;
  const status = me?.presence?.status ?? "OFFLINE";
  const statusLabel = status === "ON_JOB" ? "On a job" : status === "ONLINE" ? "Online" : "Offline";
  const statusColor = status === "OFFLINE" ? C.textMute : status === "ON_JOB" ? C.warn : C.go;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? "auto" : "none"}>
      <Animated.View style={[styles.backdrop, { opacity: fade }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close menu" />
      </Animated.View>
      <Animated.View style={[styles.panel, { transform: [{ translateX: x }] }]}>
        <ScrollView
          contentContainerStyle={{ paddingTop: 16, paddingBottom: Math.max(insets.bottom, 20), flexGrow: 1 }}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials(me?.firstName, me?.lastName)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name} numberOfLines={1}>
                {me ? `${me.firstName} ${me.lastName}` : "Driver"}
              </Text>
              <View style={styles.statusRow}>
                <StatusDot color={statusColor} live={status !== "OFFLINE"} />
                <Text style={[styles.status, { color: statusColor }]}>{statusLabel}</Text>
                {!!me?.vehicleType && <Text style={styles.vehicle}>· {me.vehicleType}</Text>}
              </View>
            </View>
          </View>

          {/* Live earnings so far today — updates as each delivery completes. */}
          <Pressable style={(s) => [styles.earnCard, s.pressed && { opacity: 0.9 }]} onPress={onOpenCashUp}>
            <View style={styles.earnTop}>
              <Text style={styles.earnLabel}>TODAY&apos;S EARNINGS</Text>
              <Icon name="trending-up" size={18} color={C.go} />
            </View>
            <Text style={styles.earnValue}>{money(day?.cashUp?.earning)}</Text>
            <View style={styles.earnSplit}>
              <Mini label="Deliveries" value={String(day?.cashUp?.deliveries ?? 0)} />
              <Mini label="Cash" value={money(day?.cashUp?.cashTotal)} />
              <Mini label="Card" value={money(day?.cashUp?.cardTotal)} />
            </View>
          </Pressable>

          <Text style={styles.section}>WORK</Text>
          <Item icon="chatbubble-ellipses-outline" label="Chat with operator" badge={chatUnread} onPress={onOpenChat} />
          <Item icon="flash-outline" label="Active orders" badge={activeCount} badgeTone="go" onPress={() => onOpenOrders("active")} />
          <Item icon="checkmark-done-outline" label="Delivered" onPress={() => onOpenOrders("delivered")} />
          <Item icon="time-outline" label="History" onPress={() => onOpenOrders("history")} />
          <Item icon="wallet-outline" label="Cash up" onPress={onOpenCashUp} />

          <View style={{ flex: 1, minHeight: 20 }} />

          <Text style={styles.section}>ACCOUNT</Text>
          {/* Above Profile on purpose: this is the thing a driver is sent here
              to find when the shop says "you're not getting the jobs". */}
          <Item icon="shield-checkmark-outline" label="Allow all permissions" onPress={onFixPermissions} />
          <Item icon="person-circle-outline" label="Profile & account" onPress={onOpenProfile} />
          <Pressable style={(s) => [styles.logout, s.pressed && { opacity: 0.8 }]} onPress={onSignOut}>
            <Icon name="log-out-outline" size={18} color={C.danger} />
            <Text style={styles.logoutText}>Log out</Text>
          </Pressable>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={styles.miniValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.miniLabel}>{label}</Text>
    </View>
  );
}

function Item({
  icon,
  label,
  badge,
  badgeTone = "danger",
  onPress,
}: {
  icon: IconName;
  label: string;
  badge?: number;
  badgeTone?: "danger" | "go";
  onPress: () => void;
}) {
  return (
    <Pressable style={(s) => [styles.item, s.pressed && { backgroundColor: C.surface2 }]} onPress={onPress}>
      <View style={styles.itemIcon}>
        <Icon name={icon} size={19} color={C.textDim} />
      </View>
      <Text style={styles.itemText}>{label}</Text>
      {badge != null && badge > 0 && (
        <View style={[styles.badge, { backgroundColor: badgeTone === "go" ? C.go : C.danger }]}>
          <Text style={[styles.badgeText, badgeTone === "go" && { color: C.onAccent }]}>{badge}</Text>
        </View>
      )}
      <Icon name="chevron-forward" size={16} color={C.textMute} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: C.overlay },
  panel: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: PANEL_W,
    backgroundColor: C.bg,
    borderRightWidth: 1,
    borderRightColor: C.border,
    paddingHorizontal: 16,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 18 },
  avatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: C.surface3,
    borderWidth: 2,
    borderColor: C.go,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: C.text, fontSize: 19, fontWeight: "900" },
  name: { color: C.text, fontSize: 19, fontWeight: "900" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  status: { fontSize: 13, fontWeight: "800" },
  vehicle: { color: C.textMute, fontSize: 13, fontWeight: "600" },
  earnCard: {
    backgroundColor: C.surface,
    borderRadius: R.lg,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
    marginBottom: 8,
  },
  earnTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  earnLabel: { color: C.textMute, fontWeight: "800", fontSize: 11, letterSpacing: 1.2 },
  earnValue: { color: C.text, fontSize: 36, fontWeight: "900", marginTop: 4, fontVariant: ["tabular-nums"] },
  earnSplit: {
    flexDirection: "row",
    gap: 10,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  miniValue: { color: C.text, fontSize: 15, fontWeight: "800", fontVariant: ["tabular-nums"] },
  miniLabel: { color: C.textMute, fontSize: 11, fontWeight: "600", marginTop: 1 },
  section: { color: C.textMute, fontSize: 11, fontWeight: "800", letterSpacing: 1.2, marginTop: 16, marginBottom: 4 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 6,
    borderRadius: R.sm,
  },
  itemIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
  },
  itemText: { flex: 1, color: C.text, fontSize: 15, fontWeight: "700" },
  badge: { borderRadius: R.pill, minWidth: 22, paddingHorizontal: 6, paddingVertical: 2, alignItems: "center" },
  badgeText: { color: "#fff", fontSize: 12, fontWeight: "900" },
  logout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(255,77,79,0.1)",
    borderWidth: 1,
    borderColor: "rgba(255,77,79,0.3)",
    borderRadius: R.md,
    paddingVertical: 14,
    marginTop: 12,
  },
  logoutText: { color: C.danger, fontWeight: "800", fontSize: 15 },
});
