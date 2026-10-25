// 6 · Live tracking — the map with our car driving the route and turning at
// corners, progress steps, the driver, private Call / Message, and the
// delivery PIN. Polls the order every 4 seconds while it's live.

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import MapView, { type LatLng as MapLatLng } from "react-native-maps";
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path, Rect, Text as SvgText } from "react-native-svg";
import { isFinished, useMyOrder } from "@/api/hooks";
import { MOCK_ROUTE } from "@/api/mock/data";
import type { LatLng, OrderDetail } from "@/api/types";
import { RoundButton } from "@/components/Bits";
import { Icon } from "@/components/Icon";
import { PressScale } from "@/components/PressScale";
import { RouteOverlay } from "@/components/RouteOverlay";
import { T } from "@/components/T";
import { MOCK } from "@/config";
import { money } from "@/lib/money";
import { fadeUp } from "@/lib/motion";
import { progressOf, type Pt } from "@/lib/route";
import type { RootScreen } from "@/navigation/types";
import { C, F, shadow } from "@/theme";

const SHEET_H = 384;

// ── Status wording ─────────────────────────────────────────────────────────

type Step = { label: string; done: boolean; live: boolean };

function stepsFor(o: OrderDetail): Step[] {
  const delivery = o.fulfillmentType === "DELIVERY";
  const s = o.status;
  const rank =
    s === "PENDING" || s === "RECEIVED" ? 0
    : s === "ACCEPTED" || s === "PREPARING" ? 1
    : s === "READY" || s === "OUT_FOR_DELIVERY" || s === "RIDER_ARRIVED" ? 2
    : 3;
  const labels = delivery ? ["Placed", "Preparing", "On the way", "Delivered"] : ["Placed", "Preparing", "Ready", "Collected"];
  return labels.map((label, i) => ({ label, done: i < rank || (i === rank && rank === 3), live: i === rank && rank < 3 }));
}

const clock = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true }).replace(" ", " ") : null;

function headline(o: OrderDetail): { title: string; sub: string } {
  const shop = o.location?.name ?? "The shop";
  const eta = clock(o.estimatedReadyAt);
  const driver = o.driver?.name ?? "Your driver";
  switch (o.status) {
    case "PENDING":
      return { title: "Waiting for payment", sub: "We'll send your order as soon as it's paid." };
    case "RECEIVED":
      return { title: "Order sent", sub: `Waiting for ${shop} to accept it` };
    case "ACCEPTED":
      return { title: eta ? `Arriving ${eta}` : "Order accepted", sub: `${shop} has your order` };
    case "PREPARING":
      return { title: eta ? `${o.fulfillmentType === "DELIVERY" ? "Arriving" : "Ready"} ${eta}` : "Preparing", sub: `${shop} is preparing your food` };
    case "READY":
      return { title: "Ready to collect", sub: `Head to ${shop}` };
    case "OUT_FOR_DELIVERY":
      return { title: eta ? `Arriving ${eta}` : "On the way", sub: `${driver} is on the way` };
    case "RIDER_ARRIVED":
      return { title: "Your driver is here", sub: `${driver} is at your door` };
    case "DELIVERED":
    case "COMPLETED":
      return { title: "Delivered. Enjoy!", sub: `From ${shop}` };
    case "COLLECTED":
      return { title: "Collected. Enjoy!", sub: `From ${shop}` };
    case "CANCELLED":
    case "REJECTED":
    case "FAILED":
      return { title: "Order cancelled", sub: o.cancelReason ?? `${shop} couldn't take this order. You won't be charged.` };
    default:
      return { title: "Order placed", sub: shop };
  }
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function Segment({ step }: { step: Step }) {
  const t = useSharedValue(0);
  useEffect(() => {
    if (step.live) t.value = withRepeat(withTiming(1, { duration: 1600, easing: Easing.linear }), -1);
    else cancelAnimation(t);
  }, [step.live, t]);
  const glint = useAnimatedStyle(() => ({ transform: [{ translateX: interpolate(t.value, [0, 1], [-60, 110]) }] }));
  return (
    <View style={[styles.seg, { backgroundColor: step.done || step.live ? C.ink : C.grey300 }]}>
      {step.live ? <Animated.View style={[styles.glint, glint]} /> : null}
    </View>
  );
}

function PinDigit({ value, index, shown }: { value: string; index: number; shown: boolean }) {
  const flip = useSharedValue(0);
  useEffect(() => {
    flip.value = 0;
    flip.value = withDelay(index * 90, withSpring(1, { damping: 10, stiffness: 160 }));
  }, [shown, index, flip]);
  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, flip.value * 1.5),
    transform: [{ perspective: 400 }, { rotateX: `${90 * (1 - flip.value)}deg` }],
  }));
  return (
    <Animated.View style={[styles.digit, style]}>
      <T style={styles.digitText}>{shown ? value : "•"}</T>
    </Animated.View>
  );
}

/** Used when the order has no coordinates yet: the design's drawn map. */
function DrawnMap({ width, height }: { width: number; height: number }) {
  return (
    <Svg width={width} height={height} viewBox="0 0 390 500" preserveAspectRatio="xMidYMid slice">
      <Rect width={390} height={500} fill={C.mapBg} />
      <Rect x={104} y={40} width={112} height={160} rx={6} fill="#DCEBD5" />
      <Rect x={280} y={80} width={90} height={120} rx={6} fill="#E4E6E1" />
      <Rect x={104} y={270} width={112} height={80} rx={6} fill="#E4E6E1" />
      <Path d="M-10 452c70-26 130 10 200-8s130-40 210-18v80H-10z" fill="#C9DCEC" />
      <SvgText x={120} y={478} fontFamily="Inter_600SemiBold" fontSize={11} fill="#6F8BA3" letterSpacing={2}>RIVER TYNE</SvgText>
      <Path d="M0 234h390M0 384h390M0 112h390M70 0v500M246 0v500M330 0v420" stroke="#FFFFFF" strokeWidth={14} />
      <Path d="M150 0v234M0 310h246" stroke="#FFFFFF" strokeWidth={8} />
    </Svg>
  );
}
const DRAWN_ROUTE: Pt[] = [
  { x: 70, y: 112 },
  { x: 70, y: 234 },
  { x: 246, y: 234 },
  { x: 246, y: 384 },
  { x: 318, y: 384 },
];

// ── Screen ─────────────────────────────────────────────────────────────────

export function TrackingScreen({ navigation, route }: RootScreen<"Tracking">) {
  const { orderId } = route.params;
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const orderQ = useMyOrder(orderId);
  const order = orderQ.data;
  const map = useRef<MapView>(null);
  const [screenRoute, setScreenRoute] = useState<Pt[] | null>(null);
  const [pinShown, setPinShown] = useState(true);
  const progress = useSharedValue(0);
  const sheetY = useSharedValue(80);

  const live = order?.status === "OUT_FOR_DELIVERY" || order?.status === "RIDER_ARRIVED";
  const delivered = order ? ["DELIVERED", "COMPLETED"].includes(order.status) : false;

  // The route in map coordinates: the sample streets in mock mode, otherwise
  // shop → (driver) → door as straight legs until the API sends a real route.
  const geoRoute: LatLng[] | null = useMemo(() => {
    if (!order || order.fulfillmentType !== "DELIVERY") return null;
    if (MOCK) return MOCK_ROUTE;
    if (order.shop && order.destination) return [order.shop, order.destination];
    return null;
  }, [order]);
  const mapH = height - SHEET_H + 40;

  useEffect(() => {
    sheetY.value = withSpring(0, { damping: 16, stiffness: 150 });
  }, [sheetY]);

  // Project the route onto the screen whenever the map settles.
  const project = async () => {
    if (!map.current || !geoRoute) return;
    try {
      const pts = await Promise.all(
        geoRoute.map((p) => map.current!.pointForCoordinate({ latitude: p.lat, longitude: p.lng })),
      );
      setScreenRoute(pts.map((p) => ({ x: p.x, y: p.y })));
    } catch {
      /* map not laid out yet; the next region change retries */
    }
  };

  const fit = () => {
    if (!map.current || !geoRoute) return;
    const coords: MapLatLng[] = geoRoute.map((p) => ({ latitude: p.lat, longitude: p.lng }));
    map.current.fitToCoordinates(coords, {
      edgePadding: { top: insets.top + 110, bottom: 90, left: 70, right: 70 },
      animated: false,
    });
  };

  // Drive the car. Keyed on the status, not the order object: every 4s poll
  // returns a new object, and restarting the drive on each would stutter.
  const hasOrder = !!order;
  useEffect(() => {
    if (!hasOrder) return;
    if (delivered) {
      progress.value = withTiming(1, { duration: 800 });
      return;
    }
    if (!live) {
      progress.value = 0;
      return;
    }
    if (MOCK) {
      // Sample mode: drive the whole route on a loop, as on the design canvas.
      progress.value = 0;
      progress.value = withRepeat(
        withSequence(
          withTiming(0, { duration: 1200 }),
          withTiming(1, { duration: 13500, easing: Easing.bezier(0.45, 0.05, 0.55, 0.95) }),
          withTiming(1, { duration: 1300 }),
        ),
        -1,
      );
    }
  }, [hasOrder, live, delivered, progress]);

  // Real orders: glide to each new driver ping over the polling interval.
  const driverLat = order?.driver?.lat;
  const driverLng = order?.driver?.lng;
  useEffect(() => {
    if (MOCK || !live || driverLat == null || driverLng == null || !map.current || !screenRoute) return;
    map.current
      .pointForCoordinate({ latitude: driverLat, longitude: driverLng })
      .then((p) => {
        progress.value = withTiming(progressOf(screenRoute, { x: p.x, y: p.y }), { duration: 3800, easing: Easing.linear });
      })
      .catch(() => {});
  }, [live, driverLat, driverLng, screenRoute, progress]);

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: sheetY.value }], opacity: 1 - sheetY.value / 120 }));

  const head = order ? headline(order) : { title: "Loading your order…", sub: "" };
  const steps = order ? stepsFor(order) : [];
  const driverName = order?.driver?.name ?? null;

  return (
    <View style={styles.root}>
      <View style={[styles.mapBox, { height: mapH }]}>
        {geoRoute ? (
          <MapView
            ref={map}
            style={StyleSheet.absoluteFill}
            mapType="mutedStandard"
            scrollEnabled={false}
            zoomEnabled={false}
            rotateEnabled={false}
            pitchEnabled={false}
            showsPointsOfInterest={false}
            showsBuildings={false}
            toolbarEnabled={false}
            onMapReady={() => {
              fit();
              setTimeout(project, 350);
            }}
            onRegionChangeComplete={project}
          />
        ) : (
          <DrawnMap width={width} height={mapH} />
        )}
        <RouteOverlay
          points={geoRoute ? screenRoute ?? [] : DRAWN_ROUTE.map((p) => ({ x: (p.x / 390) * width, y: (p.y / 500) * mapH }))}
          progress={progress}
          showCar={!!order && order.fulfillmentType === "DELIVERY" && (live || delivered || !geoRoute)}
        />
      </View>

      <View style={[styles.topRow, { top: insets.top + 4 }]}>
        <RoundButton icon="back" label="Back to home" onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate("Tabs"))} />
        <PressScale
          onPress={() => Alert.alert("Help with this order", "Order help arrives with in-app support. For now, contact the shop directly.")}
          style={[styles.help, shadow.soft]}
        >
          <T v="label">Help</T>
        </PressScale>
      </View>

      <Animated.View style={[styles.sheet, { height: SHEET_H + insets.bottom }, sheetStyle]}>
        <View style={styles.handleArea}>
          <View style={styles.handle} />
        </View>
        <ScrollView contentContainerStyle={[styles.sheetBody, { paddingBottom: insets.bottom + 30 }]} showsVerticalScrollIndicator={false}>
          <View style={{ gap: 4 }}>
            <T v="hero">{head.title}</T>
            {head.sub ? <T v="sub" style={{ fontSize: 14 }}>{head.sub}{order?.displayId ? ` · #${order.displayId}` : ""}</T> : null}
          </View>

          {steps.length ? (
            <View style={{ gap: 8 }}>
              <View style={styles.segs}>
                {steps.map((s) => <Segment key={s.label} step={s} />)}
              </View>
              <View style={styles.segs}>
                {steps.map((s) => (
                  <T key={s.label} style={[styles.segLabel, (s.live || s.done) && { color: C.ink }]}>{s.label}</T>
                ))}
              </View>
            </View>
          ) : null}

          {driverName && live ? (
            <Animated.View entering={fadeUp(0)} style={{ gap: 10 }}>
              <View style={styles.driver}>
                <View style={styles.avatar}>
                  <T style={styles.avatarText}>{driverName[0]?.toUpperCase()}</T>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <T v="item">{driverName}</T>
                  <T v="sub">Your driver</T>
                </View>
              </View>
              <View style={styles.actions}>
                <PressScale onPress={() => navigation.navigate("Call", { name: driverName })} style={styles.action} haptic>
                  <Icon name="phone" size={18} />
                  <T v="label" style={{ fontSize: 15 }}>Call</T>
                </PressScale>
                <PressScale
                  onPress={() => Alert.alert("Messages are coming", "Private messaging with your driver arrives with Eat For Less private lines.")}
                  style={styles.action}
                  haptic
                >
                  <Icon name="message" size={18} />
                  <T v="label" style={{ fontSize: 15 }}>Message</T>
                </PressScale>
              </View>
              <View style={styles.privacy}>
                <Icon name="lock" size={14} color={C.grey600} />
                <T v="sub" style={{ fontSize: 12, flex: 1 }}>Your number stays private. Calls go through Eat For Less.</T>
              </View>
            </Animated.View>
          ) : null}

          {order?.deliveryPin && !order.handedOver && !isFinished(order.status) ? (
            <View style={styles.pinCard}>
              <View style={styles.rowBetween}>
                <T style={{ fontFamily: F.heavy, fontSize: 15 }}>Delivery PIN</T>
                <PressScale onPress={() => setPinShown((s) => !s)} accessibilityLabel={pinShown ? "Hide PIN" : "Show PIN"}>
                  <T style={{ fontFamily: F.bold, fontSize: 13, textDecorationLine: "underline" }}>{pinShown ? "Hide" : "Show"}</T>
                </PressScale>
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {order.deliveryPin.split("").map((v, i) => (
                  <PinDigit key={i} value={v} index={i} shown={pinShown} />
                ))}
              </View>
              <T style={{ fontFamily: F.regular, fontSize: 13, color: "#1F1F1F", lineHeight: 18 }}>
                Give this to {driverName ?? "your driver"} at the door. Your order is only handed over with the right PIN.
              </T>
            </View>
          ) : null}

          {order ? (
            <View style={styles.summary}>
              <T v="title">Your order</T>
              {order.items.map((it) => (
                <View key={it.id} style={styles.rowBetween}>
                  <T v="body" style={{ fontSize: 14, flex: 1 }}>
                    <T style={{ fontFamily: F.bold, fontSize: 14 }}>{it.quantity}× </T>
                    {it.name}
                  </T>
                </View>
              ))}
              <View style={[styles.rowBetween, { marginTop: 4 }]}>
                <T v="label">Total</T>
                <T v="label">{money(order.total)}</T>
              </View>
            </View>
          ) : null}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.mapBg },
  mapBox: { position: "absolute", top: 0, left: 0, right: 0, overflow: "hidden" },
  topRow: { position: "absolute", left: 16, right: 16, flexDirection: "row", justifyContent: "space-between" },
  help: { height: 44, borderRadius: 22, backgroundColor: C.white, paddingHorizontal: 16, justifyContent: "center" },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: C.white,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: -8 },
    elevation: 16,
  },
  handleArea: { alignItems: "center", paddingTop: 8 },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: "#D6D6D6" },
  sheetBody: { paddingHorizontal: 16, paddingTop: 14, gap: 16 },
  segs: { flexDirection: "row", gap: 6 },
  seg: { flex: 1, height: 5, borderRadius: 3, overflow: "hidden" },
  glint: { position: "absolute", top: 0, bottom: 0, width: 40, backgroundColor: C.lime, opacity: 0.9 },
  segLabel: { flex: 1, fontFamily: F.semibold, fontSize: 11, color: C.grey500 },
  driver: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderWidth: 1, borderColor: C.grey200, borderRadius: 18 },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: "#E9E9E9", alignItems: "center", justifyContent: "center" },
  avatarText: { fontFamily: F.display, fontSize: 20, color: C.ink },
  actions: { flexDirection: "row", gap: 10 },
  action: { flex: 1, height: 52, borderRadius: 26, backgroundColor: C.grey100, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  privacy: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: -2 },
  pinCard: { backgroundColor: C.lime, borderRadius: 18, padding: 14, gap: 10 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  digit: { width: 48, height: 56, borderRadius: 12, backgroundColor: C.ink, alignItems: "center", justifyContent: "center" },
  digitText: { fontFamily: F.display, fontSize: 26, color: C.white },
  summary: { gap: 8, borderTopWidth: 1, borderTopColor: C.grey200, paddingTop: 14 },
});
