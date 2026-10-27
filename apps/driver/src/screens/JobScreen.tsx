import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import MapView, { Polyline } from "react-native-maps";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Job, JobActionType, jobAction, getCustomerChat, sendCustomerChat } from "@/services/auth";
import { SlideToConfirm, SliderSpacer } from "@/components/SlideToConfirm";
import { DriverMarker, DropMarker } from "@/components/MapMarkers";
import { Icon, IconName, RoundButton } from "@/components/ui";
import { MapPlaceholder } from "@/components/MapPlaceholder";
import { ChatScreen } from "@/screens/ChatScreen";
import { C, R, MAP_AVAILABLE, etaMinutes, mapProps, milesBetween, money, mono, shadow } from "@/theme";
import type { LatLng } from "../../App";

// Deadline colours match the dispatch console house pins.
function deadline(deadlineAt: string | null): { text: string; color: string; late: boolean } | null {
  if (!deadlineAt) return null;
  const mins = Math.round((new Date(deadlineAt).getTime() - Date.now()) / 60_000);
  if (mins < 0) return { text: `${Math.abs(mins)} min late`, color: C.danger, late: true };
  const color = mins <= 5 ? C.danger : mins <= 15 ? C.warn : C.go;
  return { text: `Due in ${mins} min`, color, late: false };
}

const STEPS = ["Assigned", "Picked up", "Arrived", "Delivered"] as const;

export function JobScreen({
  job,
  pos,
  onChanged,
  onBack,
  canMinimize,
  onMinimize,
  index,
  count,
  onPrev,
  onNext,
}: {
  job: Job;
  total?: number; // stops in the run (kept for callers; the pager uses count)
  pos: LatLng | null;
  onChanged: () => void;
  onBack?: () => void; // back to a list (manual view)
  canMinimize?: boolean; // peek the map (only before the stop is started)
  onMinimize?: () => void;
  index?: number; // position in the multi-drop run (0-based)
  count?: number; // number of active stops (for swipe between cards)
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const insets = useSafeAreaInsets();
  // Local mirror so start/arrived advance the slider instantly (server confirms
  // via onChanged → poll).
  const [local, setLocal] = useState<Job>(job);
  const [submitting, setSubmitting] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // Eat For Less handover: the customer's PIN, checked by the server.
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [sheetH, setSheetH] = useState(360);
  const [, tick] = useState(0); // re-render so the deadline pill counts down
  const mapRef = useRef<MapView | null>(null);

  const stops = count ?? 1;
  const idx = index ?? 0;
  const canSwipe = stops > 1;

  // Horizontal swipe over the details area → previous / next stop. Scoped to the
  // details section so it never fights the slide-to-confirm or the map.
  const swipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) =>
          canSwipe && Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderRelease: (_e, g) => {
          if (g.dx > 50) onPrev?.();
          else if (g.dx < -50) onNext?.();
        },
      }),
    [canSwipe, onPrev, onNext],
  );

  useEffect(() => setLocal(job), [job]);
  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const o = local.order;
  const address = [o.addressLine1, o.addressLine2, o.city, o.postcode].filter(Boolean).join(", ");
  const street = [o.addressLine1, o.addressLine2].filter(Boolean).join(", ");
  const area = [o.city, o.postcode].filter(Boolean).join(" · ");
  const pickedUp = local.status === "PICKED_UP";
  const arrived = !!local.arrivedAt;
  const step = arrived ? 2 : pickedUp ? 1 : 0;
  const due = deadline(o.deadlineAt);
  const isCash = (o.paymentMethod ?? "").toUpperCase().includes("CASH");
  const dest: LatLng | null =
    o.deliveryLat != null && o.deliveryLng != null ? { latitude: o.deliveryLat, longitude: o.deliveryLng } : null;
  const miles = pos && dest ? milesBetween(pos, dest) : null;
  const eta = pos && dest ? etaMinutes(pos, dest) : null;

  // Fit the map to driver + destination.
  useEffect(() => {
    const points = [pos, dest].filter(Boolean) as LatLng[];
    if (points.length === 2) {
      mapRef.current?.fitToCoordinates(points, {
        // mapPadding already lifts the map's frame above the sheet; this is
        // just breathing room inside what's left.
        edgePadding: { top: 90, right: 60, bottom: 50, left: 60 },
        animated: true,
      });
    } else if (points.length === 1) {
      mapRef.current?.animateToRegion({ ...points[0], latitudeDelta: 0.02, longitudeDelta: 0.02 }, 400);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos?.latitude, pos?.longitude, dest?.latitude, dest?.longitude, sheetH]);

  const initialRegion = dest
    ? { ...dest, latitudeDelta: 0.04, longitudeDelta: 0.04 }
    : pos
      ? { ...pos, latitudeDelta: 0.04, longitudeDelta: 0.04 }
      : { latitude: 52.4814, longitude: -1.8998, latitudeDelta: 0.5, longitudeDelta: 0.5 };

  function navigate() {
    // Prefer the full street address: it carries the door number + postcode, which
    // Google resolves to the exact door. The stored lat/lng is geocoded server-side
    // and can snap to the postcode centroid / a neighbouring house (e.g. routing to
    // #6 for an order at #11). Only fall back to coords when there's no postcode.
    let target = "";
    if (address && o.postcode) target = encodeURIComponent(address);
    else if (dest) target = `${dest.latitude},${dest.longitude}`;
    else if (address) target = encodeURIComponent(address);
    if (!target) {
      Alert.alert("No address", "This order has no address to navigate to.");
      return;
    }
    Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${target}`);
  }

  // Marketplace orders (Just Eat / Uber Eats / Deliveroo) mask the customer's
  // number; dialling it only connects once the per-order access code is keyed
  // in. Pauses in a tel: URL let the dialler do that itself — a driver stood
  // at a door should never be reading a PIN off a ticket and typing it in.
  //
  // Two things make this fiddly, and both silently dropped the PIN before:
  //
  //  1. THE NUMBER HAS SPACES. Uber sends "+44 1388 436844". A space
  //     terminates a tel: URI, so everything after it — including the
  //     ",,PIN" suffix — was thrown away and the call went through as a
  //     plain number. Strip to a leading + and digits.
  //  2. RAW COMMAS ARE UNRELIABLE. Some Android diallers drop a literal
  //     comma while parsing the URI. %2C survives, and iOS decodes it back
  //     to a comma, so the encoded form works on both.
  //
  // Three pauses ≈ 6s: enough for the marketplace's "enter your code"
  // prompt to finish before the digits are sent. Too few and the PIN is
  // keyed into silence and lost.
  function telUrl(number: string, accessCode?: string | null) {
    const dial = String(number)
      .replace(/[^\d+]/g, "") // spaces, brackets, dashes all break the URI
      .replace(/(?!^)\+/g, ""); // a + is only valid as the very first char
    const code = accessCode ? String(accessCode).replace(/\D/g, "") : "";
    if (!code) return `tel:${dial}`;
    return `tel:${dial}%2C%2C%2C${code}`;
  }

  // Whichever number Call will actually dial is the one whose PIN matters.
  const callPin = o.courierPhone ? o.courierPhoneAccessCode : o.customerPhoneAccessCode;

  function call() {
    if (o.courierPhone) {
      Linking.openURL(telUrl(o.courierPhone, o.courierPhoneAccessCode));
      return;
    }
    if (o.customerPhone) {
      Linking.openURL(telUrl(o.customerPhone, o.customerPhoneAccessCode));
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
      // The API's own message is on the axios response; (err as Error).message
      // is only "Request failed with status code 400", which tells a driver
      // stood on a doorstep nothing. The one that matters here is the closed-
      // order guard: the operator completed this stop on the board, or the 5am
      // rollover swept it up overnight.
      const detail = (err as any)?.response?.data?.message;
      Alert.alert(
        "Error",
        (Array.isArray(detail) ? detail.join("\n") : detail) || (err as Error)?.message || "Try again",
      );
      // A refused action means our copy of the job is stale — refresh so a card
      // for an order that has already closed drops off the screen.
      onChanged();
      // The card stays up, so the slider must come back for another try.
      setSubmitting(false);
      return;
    }
    if (action === "start" || action === "arrived") setSubmitting(false);
    // For terminal actions keep the spinner until App unmounts this card.
  }

  function slideDelivered() {
    if (!o.deliveryPinRequired) return act("delivered");
    setPin("");
    setPinError(null);
    setPinOpen(true);
  }

  async function submitPin() {
    if (pin.length !== 4 || pinBusy) return;
    setPinBusy(true);
    setPinError(null);
    try {
      await jobAction(o.id, "delivered", { pin });
      setPinOpen(false);
      setSubmitting(true); // App unmounts this card on the next refresh
      onChanged();
      onBack?.();
    } catch (err) {
      const data = (err as any)?.response?.data;
      const message = (Array.isArray(data?.message) ? data.message.join("\n") : data?.message) || "Couldn't check the PIN. Try again.";
      if (data?.code === "PIN_LOCKED") {
        setPinOpen(false);
        Alert.alert("Handover locked", message);
        onChanged();
      } else {
        setPin("");
        setPinError(message);
      }
    } finally {
      setPinBusy(false);
    }
  }

  function confirmSkip() {
    setOptionsOpen(false);
    Alert.alert("Skip this delivery?", "Use when the customer didn't answer.", [
      { text: "Cancel", style: "cancel" },
      { text: "Skip", style: "destructive", onPress: () => act("skip") },
    ]);
  }
  function confirmCancel() {
    setOptionsOpen(false);
    Alert.alert("Cancel this job?", "Returns the order to dispatch (use for incidents).", [
      { text: "Back", style: "cancel" },
      { text: "Cancel job", style: "destructive", onPress: () => act("cancel") },
    ]);
  }

  const orderRef = `#${o.displayId ?? o.orderNumber ?? o.id.slice(-5)}`;
  const stopNo = local.sequence ?? 1;
  const headline = arrived ? "At the door" : pickedUp ? "Heading to customer" : "Collect & start";
  const subline = arrived
    ? isCash
      ? "Take payment, hand over, then slide"
      : "Hand over the order, then slide"
    : pickedUp
      ? "Slide when you reach the address"
      : "Pick up the order, then slide to start";

  return (
    <View style={styles.container}>
      {MAP_AVAILABLE ? (
        <MapView
          ref={mapRef}
          {...mapProps}
          style={StyleSheet.absoluteFill}
          initialRegion={initialRegion}
          showsUserLocation={false}
          showsCompass={false}
          toolbarEnabled={false}
          mapPadding={{ top: 0, right: 0, bottom: sheetH - 20, left: 0 }}
        >
          {pos && dest && (
            <Polyline
              coordinates={[pos, dest]}
              strokeColor={C.go}
              strokeWidth={4}
              lineDashPattern={[10, 8]}
              lineCap="round"
            />
          )}
          {pos && <DriverMarker coordinate={pos} heading={pos.heading} />}
          {dest && <DropMarker coordinate={dest} label={String(stopNo)} title={o.customerName ?? "Customer"} />}
        </MapView>
      ) : (
        <MapPlaceholder />
      )}

      {/* Top overlay: back · stop pager · deadline */}
      <View style={styles.topRow} pointerEvents="box-none">
        {canMinimize || onBack ? (
          <RoundButton
            icon={canMinimize ? "chevron-down" : "chevron-back"}
            onPress={canMinimize ? onMinimize : onBack}
            accessibilityLabel={canMinimize ? "Show the map" : "Back"}
          />
        ) : (
          <View style={{ width: 48 }} />
        )}
        {canSwipe ? (
          <View style={[styles.pager, shadow]}>
            <Pressable onPress={onPrev} disabled={idx === 0} hitSlop={10} style={{ opacity: idx === 0 ? 0.25 : 1 }}>
              <Icon name="chevron-back" size={18} />
            </Pressable>
            <Text style={styles.pagerText}>
              Stop {idx + 1} of {stops}
            </Text>
            <Pressable
              onPress={onNext}
              disabled={idx === stops - 1}
              hitSlop={10}
              style={{ opacity: idx === stops - 1 ? 0.25 : 1 }}
            >
              <Icon name="chevron-forward" size={18} />
            </Pressable>
          </View>
        ) : (
          <View />
        )}
        {due ? (
          <View style={[styles.dueChip, shadow, { borderColor: due.color }]}>
            <Icon name={due.late ? "alert-circle" : "time"} size={14} color={due.color} />
            <Text style={[styles.dueText, { color: due.color }]}>{due.text}</Text>
          </View>
        ) : (
          <View style={{ width: 48 }} />
        )}
      </View>

      {/* Bottom sheet */}
      <View
        style={[styles.sheet, shadow, { paddingBottom: Math.max(insets.bottom, 14) }]}
        onLayout={(e) => setSheetH(e.nativeEvent.layout.height)}
      >
        <Pressable style={[styles.navBtn, shadow]} onPress={navigate} accessibilityLabel="Navigate">
          <Icon name="navigate" size={18} color="#fff" />
          <Text style={styles.navText}>Navigate</Text>
        </Pressable>

        <Steps step={step} />

        <ScrollView
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ paddingBottom: 6 }}
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          <View {...swipe.panHandlers}>
            <View style={styles.refRow}>
              <Text style={styles.ref}>{orderRef}</Text>
              <View style={styles.refDot} />
              {/* The stop's number in the original run — the same number as its
                  map pin and the dispatcher's sequence. The pager above counts
                  stops still to do, which shrinks as drops complete. */}
              <Text style={styles.refStop}>Drop {stopNo}</Text>
              {!!o.platform && <Text style={styles.platform}>{o.platform.replace(/_/g, " ")}</Text>}
            </View>
            <Text style={styles.headline}>{headline}</Text>
            <Text style={styles.subline}>{subline}</Text>

            <View style={styles.card}>
              <View style={styles.custRow}>
                <View style={styles.custIcon}>
                  <Icon name="person" size={18} color={C.textDim} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.customer} numberOfLines={1}>
                    {o.customerName ?? "Customer"}
                  </Text>
                  {!!street && <Text style={styles.address}>{street}</Text>}
                  {!!area && <Text style={styles.area}>{area}</Text>}
                </View>
                {miles != null && eta != null && (
                  <View style={styles.eta}>
                    <Text style={styles.etaValue}>{eta}</Text>
                    <Text style={styles.etaUnit}>min</Text>
                    <Text style={styles.etaMiles}>{miles.toFixed(1)} mi</Text>
                  </View>
                )}
              </View>

              {!!o.specialInstructions && (
                <View style={styles.note}>
                  <Icon name="chatbox-ellipses" size={15} color={C.warn} />
                  <Text style={styles.noteText}>{o.specialInstructions}</Text>
                </View>
              )}

              {/* Masked-number access code, shown as well as auto-dialled. Some
                  networks and diallers ignore pause characters in a tel: URL,
                  and a driver stood at a door with no way to see the PIN is
                  stuck. Call still keys it in automatically. */}
              {!!callPin && (
                <View style={styles.pin}>
                  <Text style={styles.pinLabel}>CALL PIN</Text>
                  <Text style={styles.pinCode}>{callPin}</Text>
                </View>
              )}
            </View>

            <View style={[styles.payRow, isCash && styles.payRowCash]}>
              <Icon name={isCash ? "cash" : "card"} size={20} color={isCash ? C.brand : C.textDim} />
              <Text style={[styles.payLabel, isCash && { color: C.brand }]}>
                {isCash ? "Collect cash" : `Paid · ${(o.paymentMethod ?? "online").replace(/_/g, " ").toLowerCase()}`}
              </Text>
              <Text style={[styles.payValue, isCash && { color: C.brand }]}>{money(o.total)}</Text>
            </View>
          </View>

          <View style={styles.actions}>
            <Action icon="call" label="Call" tone={C.go} onPress={call} />
            <Action icon="chatbubble-ellipses" label="Message" onPress={() => setChatOpen(true)} />
            <Action icon="paper-plane" label="Text" onPress={notify} />
            <Action icon="ellipsis-horizontal" label="More" onPress={() => setOptionsOpen(true)} />
          </View>
        </ScrollView>

        <View style={{ marginTop: 10 }}>
          {submitting ? (
            <SliderSpacer>
              <ActivityIndicator color={C.text} />
            </SliderSpacer>
          ) : !pickedUp ? (
            <SlideToConfirm label="Slide to start delivery" color={C.go} icon="arrow-forward" onConfirm={() => act("start")} />
          ) : !arrived ? (
            <SlideToConfirm label="Arrived at customer" color={C.warn} icon="location" onConfirm={() => act("arrived")} />
          ) : (
            <SlideToConfirm label="Slide to delivered" color={C.info} icon="checkmark" onConfirm={slideDelivered} />
          )}
        </View>
      </View>

      {/* Options sheet — dismissable (tap a row, the backdrop, or Close) */}
      <Modal visible={optionsOpen} transparent animationType="slide" onRequestClose={() => setOptionsOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setOptionsOpen(false)}>
          <Pressable style={[styles.optSheet, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]} onPress={() => {}}>
            <View style={styles.handle} />
            <Text style={styles.optTitle}>DELIVERY OPTIONS · {orderRef}</Text>
            <OptRow
              icon="navigate-outline"
              label="Navigate"
              onPress={() => {
                setOptionsOpen(false);
                navigate();
              }}
            />
            <OptRow
              icon="chatbubble-ellipses-outline"
              label="Message customer"
              onPress={() => {
                setOptionsOpen(false);
                setChatOpen(true);
              }}
            />
            <OptRow icon="person-remove-outline" label="Skip (no answer)" color={C.warn} onPress={confirmSkip} />
            <OptRow icon="close-circle-outline" label="Cancel job" color={C.danger} onPress={confirmCancel} />
            <Pressable style={styles.optClose} onPress={() => setOptionsOpen(false)}>
              <Text style={styles.optCloseText}>Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Eat For Less handover PIN */}
      <Modal visible={pinOpen} transparent animationType="slide" onRequestClose={() => setPinOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => !pinBusy && setPinOpen(false)}>
          <Pressable style={[styles.optSheet, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]} onPress={() => {}}>
            <View style={styles.handle} />
            <Text style={styles.optTitle}>HANDOVER · {orderRef}</Text>
            <Text style={styles.pinTitle}>Customer&apos;s PIN</Text>
            <Text style={styles.pinSub}>Ask for the 4-digit PIN in their Eat For Less app. Don&apos;t hand the order over without it.</Text>
            <TextInput
              value={pin}
              onChangeText={(t) => {
                setPin(t.replace(/\D/g, "").slice(0, 4));
                setPinError(null);
              }}
              keyboardType="number-pad"
              maxLength={4}
              autoFocus
              textContentType="oneTimeCode"
              accessibilityLabel="Customer's 4-digit PIN"
              style={styles.pinInput}
              placeholder="••••"
              placeholderTextColor={C.textMute}
              onSubmitEditing={submitPin}
            />
            {pinError ? <Text style={styles.pinError}>{pinError}</Text> : null}
            <Pressable
              onPress={submitPin}
              disabled={pin.length !== 4 || pinBusy}
              style={[styles.pinButton, (pin.length !== 4 || pinBusy) && { opacity: 0.4 }]}
              accessibilityRole="button"
            >
              {pinBusy ? <ActivityIndicator color={C.onAccent} /> : <Text style={styles.pinButtonText}>Confirm delivered</Text>}
            </Pressable>
            <Pressable style={styles.optClose} onPress={() => setPinOpen(false)} disabled={pinBusy}>
              <Text style={styles.optCloseText}>Not yet</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Customer chat */}
      <Modal visible={chatOpen} animationType="slide" onRequestClose={() => setChatOpen(false)}>
        <ChatScreen
          title={o.customerName ?? "Customer"}
          subtitle={`Delivery chat · ${orderRef}`}
          mine="DRIVER"
          load={() => getCustomerChat(o.id)}
          send={(text) => sendCustomerChat(o.id, text)}
          onBack={() => setChatOpen(false)}
          standalone
        />
      </Modal>
    </View>
  );
}

function Steps({ step }: { step: number }) {
  return (
    <View style={styles.steps}>
      {STEPS.map((s, i) => {
        const done = i <= step;
        const current = i === step + 1;
        return (
          <View key={s} style={{ flex: 1 }}>
            <View style={[styles.stepBar, done && styles.stepBarDone, current && styles.stepBarNext]} />
            <Text style={[styles.stepText, done && { color: C.text }, current && { color: C.go }]} numberOfLines={1}>
              {s}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function Action({ icon, label, onPress, tone }: { icon: IconName; label: string; onPress: () => void; tone?: string }) {
  return (
    <Pressable
      onPress={onPress}
      style={(s) => [styles.action, s.pressed && { transform: [{ scale: 0.95 }], opacity: 0.85 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[styles.actionIcon, tone ? { backgroundColor: tone, borderColor: tone } : null]}>
        <Icon name={icon} size={20} color={tone ? C.onAccent : C.text} />
      </View>
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

function OptRow({ icon, label, color = C.text, onPress }: { icon: IconName; label: string; color?: string; onPress: () => void }) {
  return (
    <Pressable style={(s) => [styles.optRow, s.pressed && { backgroundColor: C.surface2 }]} onPress={onPress}>
      <Icon name={icon} size={21} color={color} />
      <Text style={[styles.optRowText, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  topRow: {
    position: "absolute",
    top: 10,
    left: 14,
    right: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  pager: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 44,
    paddingHorizontal: 14,
    borderRadius: R.pill,
    backgroundColor: C.glass,
    borderWidth: 1,
    borderColor: C.border,
  },
  pagerText: { color: C.text, fontWeight: "800", fontSize: 14 },
  dueChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: R.pill,
    backgroundColor: C.glass,
    borderWidth: 1,
  },
  dueText: { fontWeight: "800", fontSize: 13 },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "68%",
    backgroundColor: C.bg,
    borderTopLeftRadius: R.xl,
    borderTopRightRadius: R.xl,
    borderTopWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  navBtn: {
    position: "absolute",
    right: 16,
    top: -62,
    height: 46,
    paddingHorizontal: 18,
    borderRadius: R.pill,
    backgroundColor: C.info,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  navText: { color: "#fff", fontWeight: "900", fontSize: 15 },
  steps: { flexDirection: "row", gap: 6, marginBottom: 12 },
  stepBar: { height: 4, borderRadius: 2, backgroundColor: C.surface3 },
  stepBarDone: { backgroundColor: C.go },
  stepBarNext: { backgroundColor: "rgba(30,214,127,0.35)" },
  stepText: { color: C.textMute, fontSize: 10, fontWeight: "800", marginTop: 5, letterSpacing: 0.3 },
  refRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  ref: { color: C.textDim, fontFamily: mono, fontSize: 13, fontWeight: "700" },
  refDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: C.textMute },
  refStop: { color: C.textDim, fontSize: 13, fontWeight: "700" },
  platform: {
    marginLeft: "auto",
    color: C.textDim,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    backgroundColor: C.surface2,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    overflow: "hidden",
  },
  headline: { color: C.text, fontSize: 22, fontWeight: "900", marginTop: 4 },
  subline: { color: C.textDim, fontSize: 14, marginTop: 2 },
  card: {
    marginTop: 12,
    backgroundColor: C.surface,
    borderRadius: R.lg,
    borderWidth: 1,
    borderColor: C.border,
    padding: 12,
    gap: 10,
  },
  custRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  custIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.surface3,
    alignItems: "center",
    justifyContent: "center",
  },
  customer: { color: C.text, fontSize: 17, fontWeight: "800" },
  address: { color: C.textDim, fontSize: 14, marginTop: 2 },
  area: { color: C.textMute, fontSize: 13, marginTop: 1, fontWeight: "600" },
  eta: {
    alignItems: "center",
    paddingLeft: 12,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: C.border,
  },
  etaValue: { color: C.go, fontSize: 24, fontWeight: "900", fontVariant: ["tabular-nums"], lineHeight: 26 },
  etaUnit: { color: C.go, fontSize: 11, fontWeight: "800" },
  etaMiles: { color: C.textMute, fontSize: 11, fontWeight: "700", marginTop: 2 },
  note: {
    flexDirection: "row",
    gap: 8,
    backgroundColor: "rgba(245,165,36,0.1)",
    borderRadius: R.sm,
    padding: 10,
    borderWidth: 1,
    borderColor: "rgba(245,165,36,0.3)",
  },
  noteText: { flex: 1, color: "#F7CD7E", fontSize: 14, lineHeight: 19 },
  pin: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: C.surface2,
    borderRadius: R.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  pinLabel: { color: C.textMute, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  pinCode: { color: C.text, fontSize: 22, fontWeight: "900", letterSpacing: 4, fontFamily: mono },
  payRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
    paddingHorizontal: 14,
    height: 52,
    borderRadius: R.md,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  payRowCash: { backgroundColor: "rgba(255,122,26,0.1)", borderColor: "rgba(255,122,26,0.45)" },
  payLabel: { flex: 1, color: C.textDim, fontSize: 15, fontWeight: "800", textTransform: "capitalize" },
  payValue: { color: C.text, fontSize: 20, fontWeight: "900", fontVariant: ["tabular-nums"] },
  actions: { flexDirection: "row", justifyContent: "space-between", marginTop: 12 },
  action: { flex: 1, alignItems: "center", gap: 6 },
  actionIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
  },
  actionLabel: { color: C.textDim, fontSize: 12, fontWeight: "700" },
  sheetBackdrop: { flex: 1, backgroundColor: C.overlay, justifyContent: "flex-end" },
  optSheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: R.xl,
    borderTopRightRadius: R.xl,
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: 1,
    borderColor: C.border,
  },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: C.borderStrong, marginBottom: 14 },
  optTitle: { fontSize: 11, fontWeight: "800", color: C.textMute, letterSpacing: 1, marginBottom: 6 },
  optRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 15, paddingHorizontal: 6, borderRadius: R.sm },
  optRowText: { fontSize: 16, fontWeight: "800" },
  optClose: { marginTop: 10, backgroundColor: C.surface3, borderRadius: R.md, paddingVertical: 15, alignItems: "center" },
  optCloseText: { fontSize: 16, fontWeight: "800", color: C.text },
  pinTitle: { fontSize: 22, fontWeight: "900", color: C.text, marginTop: 4 },
  pinSub: { fontSize: 14, color: C.textDim, marginTop: 6, lineHeight: 20 },
  pinInput: {
    marginTop: 18,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.borderStrong,
    borderRadius: R.md,
    paddingVertical: 14,
    textAlign: "center",
    fontSize: 34,
    fontWeight: "900",
    letterSpacing: 18,
    color: C.text,
  },
  pinError: { color: C.danger, fontSize: 14, fontWeight: "700", marginTop: 10 },
  pinButton: { marginTop: 16, backgroundColor: C.go, borderRadius: R.md, paddingVertical: 16, alignItems: "center" },
  pinButtonText: { fontSize: 16, fontWeight: "900", color: C.onAccent },
});
