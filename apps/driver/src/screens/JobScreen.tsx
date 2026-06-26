import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";
import { Job, JobActionType, jobAction } from "@/services/auth";
import { SlideToConfirm } from "@/components/SlideToConfirm";
import type { LatLng } from "../../App";

// Deadline colours match the dispatch console house pins.
function deadline(deadlineAt: string | null): { text: string; color: string; late: boolean } | null {
  if (!deadlineAt) return null;
  const mins = Math.round((new Date(deadlineAt).getTime() - Date.now()) / 60_000);
  if (mins < 0) return { text: `${Math.abs(mins)}min after deadline`, color: "#dc2626", late: true };
  const color = mins <= 5 ? "#dc2626" : mins <= 15 ? "#f97316" : "#16a34a";
  return { text: `Due in ${mins}min`, color, late: false };
}

export function JobScreen({
  job,
  total,
  pos,
  onChanged,
  onBack,
  canMinimize,
  onMinimize,
}: {
  job: Job;
  total: number;
  pos: LatLng | null;
  onChanged: () => void;
  onBack?: () => void; // back to a list (manual view)
  canMinimize?: boolean; // peek the map (only before the stop is started)
  onMinimize?: () => void;
}) {
  // Local mirror so start/arrived advance the slider instantly (server confirms
  // via onChanged → poll).
  const [local, setLocal] = useState<Job>(job);
  const [submitting, setSubmitting] = useState(false);
  const [, tick] = useState(0); // re-render so the deadline pill counts down
  const mapRef = useRef<MapView | null>(null);

  useEffect(() => setLocal(job), [job]);
  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const o = local.order;
  const address = [o.addressLine1, o.addressLine2, o.city, o.postcode].filter(Boolean).join(", ");
  const pickedUp = local.status === "PICKED_UP";
  const arrived = !!local.arrivedAt;
  const due = deadline(o.deadlineAt);
  const dest: LatLng | null =
    o.deliveryLat != null && o.deliveryLng != null
      ? { latitude: o.deliveryLat, longitude: o.deliveryLng }
      : null;
  const coordLabel =
    o.deliveryLat != null && o.deliveryLng != null
      ? `${o.deliveryLat.toFixed(4)}, ${o.deliveryLng.toFixed(4)}`
      : null;

  // Fit the map to driver + destination once we have them.
  useEffect(() => {
    const points = [pos, dest].filter(Boolean) as LatLng[];
    if (points.length === 2) {
      mapRef.current?.fitToCoordinates(points, {
        edgePadding: { top: 60, right: 60, bottom: 60, left: 60 },
        animated: true,
      });
    } else if (points.length === 1) {
      mapRef.current?.animateCamera({ center: points[0], zoom: 14 }, { duration: 400 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos?.latitude, pos?.longitude, dest?.latitude, dest?.longitude]);

  const initialRegion = dest
    ? { ...dest, latitudeDelta: 0.04, longitudeDelta: 0.04 }
    : pos
      ? { ...pos, latitudeDelta: 0.04, longitudeDelta: 0.04 }
      : { latitude: 52.4814, longitude: -1.8998, latitudeDelta: 0.5, longitudeDelta: 0.5 };

  function navigate() {
    let target = "";
    if (dest) target = `${dest.latitude},${dest.longitude}`;
    else if (address) target = encodeURIComponent(address);
    if (!target) {
      Alert.alert("No address", "This order has no address to navigate to.");
      return;
    }
    Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${target}`);
  }

  // Marketplace orders (Just Eat / Uber Eats / Deliveroo) mask the customer's
  // number behind courierPhone; some need the access code dialled after a pause.
  function call() {
    if (o.courierPhone) {
      const tel = o.courierPhoneAccessCode
        ? `tel:${o.courierPhone},,${o.courierPhoneAccessCode}`
        : `tel:${o.courierPhone}`;
      Linking.openURL(tel);
      return;
    }
    if (o.customerPhone) {
      Linking.openURL(`tel:${o.customerPhone}`);
      return;
    }
    Alert.alert("No phone", "No phone number on this order.");
  }

  function notify() {
    const phone = o.customerPhone ?? o.courierPhone;
    if (!phone) {
      Alert.alert("No phone", "No number to text on this order.");
      return;
    }
    const body = encodeURIComponent("Hi, your Order Hub delivery driver is on the way.");
    // iOS uses "&" as the sms query separator, Android uses "?".
    const sep = Platform.OS === "ios" ? "&" : "?";
    Linking.openURL(`sms:${phone}${sep}body=${body}`);
  }

  async function act(action: JobActionType) {
    setSubmitting(true);
    try {
      await jobAction(o.id, action);
      if (action === "start") setLocal((j) => ({ ...j, status: "PICKED_UP" }));
      if (action === "arrived") setLocal((j) => ({ ...j, arrivedAt: new Date().toISOString() }));
      onChanged();
      if (action !== "start" && action !== "arrived") {
        // Terminal: hand back if this was a manual view; otherwise App routes to
        // the next stop (or home) on the next refresh.
        onBack?.();
      }
    } catch (err) {
      Alert.alert("Error", (err as Error)?.message ?? "Try again");
    } finally {
      if (action === "start" || action === "arrived") setSubmitting(false);
      // For terminal actions keep the spinner until App unmounts this card.
    }
  }

  function options() {
    Alert.alert("Delivery options", undefined, [
      { text: "Navigate", onPress: navigate },
      {
        text: "Skip (no answer)",
        style: "destructive",
        onPress: () =>
          Alert.alert("Skip this delivery?", "Use when the customer didn't answer.", [
            { text: "Cancel", style: "cancel" },
            { text: "Skip", style: "destructive", onPress: () => act("skip") },
          ]),
      },
      {
        text: "Cancel job",
        style: "destructive",
        onPress: () =>
          Alert.alert("Cancel this job?", "Returns the order to dispatch (use for incidents).", [
            { text: "Back", style: "cancel" },
            { text: "Cancel job", style: "destructive", onPress: () => act("cancel") },
          ]),
      },
      { text: "Close", style: "cancel" },
    ]);
  }

  const stopLabel = `${local.sequence ?? 1}/${total || 1}.`;
  const orderRef = `#${o.displayId ?? o.orderNumber ?? o.id.slice(-5)}`;
  // Secondary reference (the platform/external id) — shown when we have a
  // human displayId, mirroring "#002 vNUHOnOWb7".
  const extRef = o.displayId ? o.id.slice(-10) : "";

  return (
    <View style={styles.container}>
      {/* Map */}
      <View style={styles.mapWrap}>
        <MapView
          ref={mapRef}
          provider={PROVIDER_GOOGLE}
          style={StyleSheet.absoluteFill}
          initialRegion={initialRegion}
          showsUserLocation={false}
        >
          {pos && (
            <Marker coordinate={pos} title="You" anchor={{ x: 0.5, y: 0.5 }}>
              <View style={styles.carBadge}>
                <Text style={{ fontSize: 18 }}>🚗</Text>
              </View>
            </Marker>
          )}
          {dest && <Marker coordinate={dest} title={o.customerName ?? "Customer"} description={coordLabel ?? undefined} pinColor="#dc2626" />}
        </MapView>

        {/* Map overlay buttons */}
        {(canMinimize || onBack) && (
          <Pressable style={[styles.fab, styles.fabTL]} onPress={canMinimize ? onMinimize : onBack}>
            <Text style={styles.fabIcon}>‹</Text>
          </Pressable>
        )}
        <Pressable style={[styles.fab, styles.fabTR]} onPress={navigate}>
          <Text style={styles.navIcon}>➤</Text>
        </Pressable>
        {coordLabel && (
          <View style={styles.coordChip}>
            <Text style={styles.coordChipText}>{coordLabel}</Text>
          </View>
        )}
      </View>

      {/* Action bar */}
      <View style={styles.actionBar}>
        <Pressable style={styles.sideAction} onPress={notify}>
          <Text style={styles.sideIcon}>✉️</Text>
          <Text style={styles.sideLabel}>notify</Text>
        </Pressable>
        <Pressable style={styles.callBtn} onPress={call}>
          <Text style={styles.callIcon}>📞</Text>
        </Pressable>
        <Pressable style={styles.sideAction} onPress={options}>
          <Text style={styles.sideIcon}>☰</Text>
          <Text style={styles.sideLabel}>options</Text>
        </Pressable>
      </View>

      {/* Details */}
      <View style={styles.details}>
        <Text style={styles.orderLine}>
          <Text style={styles.stopNo}>{stopLabel} </Text>
          {orderRef} {extRef ? <Text style={styles.extRef}>{extRef}</Text> : null}
        </Text>
        {coordLabel && <Text style={styles.subCoord}>{coordLabel}</Text>}
        <Text style={styles.customer}>{o.customerName ?? "Customer"}</Text>
        {!!address && <Text style={styles.address}>{address}</Text>}
        {!!o.specialInstructions && <Text style={styles.note}>“{o.specialInstructions}”</Text>}

        <View style={styles.metaRow}>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>{(o.paymentMethod ?? "—").toUpperCase()}</Text>
            <Text style={styles.metaValue}>£{o.total}</Text>
          </View>
          <View style={[styles.metaCell, styles.metaCellRight]}>
            {due ? (
              <>
                <Text style={[styles.metaLabel, { color: due.color }]}>
                  {due.late ? "After deadline" : "Deadline"}
                </Text>
                <Text style={[styles.metaValue, { color: due.color }]}>{due.text}</Text>
              </>
            ) : (
              <>
                <Text style={styles.metaLabel}>STATUS</Text>
                <Text style={styles.metaValue}>{arrived ? "ARRIVED" : local.status}</Text>
              </>
            )}
          </View>
        </View>
      </View>

      {/* Slide action */}
      <View style={styles.footer}>
        {submitting ? (
          <View style={styles.busy}>
            <ActivityIndicator color="#0F172A" />
          </View>
        ) : !pickedUp ? (
          <SlideToConfirm label="Slide to start delivery" color="#16a34a" onConfirm={() => act("start")} />
        ) : !arrived ? (
          <SlideToConfirm label="Arrived at customer" color="#f97316" onConfirm={() => act("arrived")} />
        ) : (
          <SlideToConfirm label="Slide to delivered ✓" color="#475569" onConfirm={() => act("delivered")} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  mapWrap: { flex: 1, minHeight: 220 },
  carBadge: {
    backgroundColor: "#fff",
    borderRadius: 20,
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#2563eb",
  },
  fab: {
    position: "absolute",
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  fabTL: { top: 12, left: 12 },
  fabTR: { top: 12, right: 12 },
  fabIcon: { fontSize: 26, fontWeight: "800", color: "#0F172A", marginTop: -2 },
  navIcon: { fontSize: 18, color: "#2563eb", transform: [{ rotate: "-45deg" }] },
  coordChip: {
    position: "absolute",
    alignSelf: "center",
    bottom: 14,
    backgroundColor: "#fff",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    elevation: 3,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  coordChipText: { fontSize: 13, fontWeight: "700", color: "#0F172A" },
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
    backgroundColor: "#fff",
  },
  sideAction: { alignItems: "center", width: 70, gap: 2 },
  sideIcon: { fontSize: 20 },
  sideLabel: { fontSize: 12, color: "#64748b", fontWeight: "600" },
  callBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#16a34a",
    alignItems: "center",
    justifyContent: "center",
    marginTop: -28,
    borderWidth: 4,
    borderColor: "#fff",
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  callIcon: { fontSize: 26 },
  details: { paddingHorizontal: 18, paddingTop: 14 },
  orderLine: { fontSize: 18, fontWeight: "800", color: "#0F172A" },
  stopNo: { color: "#2563eb" },
  extRef: { color: "#94a3b8", fontWeight: "700", fontSize: 15 },
  subCoord: { fontSize: 13, color: "#94a3b8", marginTop: 2 },
  customer: { fontSize: 16, fontWeight: "700", color: "#334155", marginTop: 6 },
  address: { fontSize: 14, color: "#475569", marginTop: 2 },
  note: { fontStyle: "italic", color: "#b45309", marginTop: 6 },
  metaRow: {
    flexDirection: "row",
    marginTop: 14,
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
  },
  metaCell: { flex: 1, paddingVertical: 12 },
  metaCellRight: { alignItems: "flex-end", borderLeftWidth: 1, borderLeftColor: "#e2e8f0", paddingLeft: 12 },
  metaLabel: { fontSize: 11, color: "#94a3b8", fontWeight: "700", letterSpacing: 0.5 },
  metaValue: { fontSize: 18, fontWeight: "800", color: "#0F172A", marginTop: 2 },
  footer: { padding: 16, borderTopWidth: 1, borderTopColor: "#e2e8f0" },
  busy: { height: 60, alignItems: "center", justifyContent: "center" },
});
