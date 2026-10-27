// 5 · Basket + checkout — delivery or pickup, address, when, the order (with
// steppers), tip, totals, then Stripe's payment sheet (card, Apple Pay,
// Google Pay). The server re-prices everything; these totals are the preview.

import { useQueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path, Rect } from "react-native-svg";
import { ApiError } from "@/api/client";
import { checkout } from "@/api/efl";
import { useShopMenu, useShops } from "@/api/hooks";
import type { CheckoutBody } from "@/api/types";
import { useSession } from "@/auth/session";
import { RoundButton, Stepper, TagMark } from "@/components/Bits";
import { Icon } from "@/components/Icon";
import { Photo } from "@/components/Photo";
import { PressScale } from "@/components/PressScale";
import { T } from "@/components/T";
import { foodKind } from "@/lib/menu";
import { money, round2 } from "@/lib/money";
import { fadeUp } from "@/lib/motion";
import { payForOrder } from "@/lib/pay";
import type { RootScreen } from "@/navigation/types";
import { searchPoint, useSelectedAddress } from "@/state/address";
import { basketCount, basketSubtotal, useBasket } from "@/state/basket";
import { C, F, MOTION, shadow } from "@/theme";

const TIPS = [0, 1, 2, 3];

function MiniMap() {
  const bob = useSharedValue(0);
  const ring = useSharedValue(0);
  useEffect(() => {
    bob.value = withRepeat(withSequence(withTiming(1, { duration: 900, easing: Easing.out(Easing.quad) }), withSpring(0, { damping: 6, stiffness: 140 })), -1);
    ring.value = withRepeat(withTiming(1, { duration: 1800, easing: Easing.out(Easing.quad) }), -1);
  }, [bob, ring]);
  const pin = useAnimatedStyle(() => ({ transform: [{ translateY: -6 * bob.value }, { rotate: "-45deg" }] }));
  const ringStyle = useAnimatedStyle(() => ({ opacity: 0.6 * (1 - ring.value), transform: [{ scale: 0.4 + ring.value * 1.2 }] }));
  return (
    <View style={{ height: 110, backgroundColor: "#ECEEEA", overflow: "hidden" }}>
      <Svg width="100%" height={110} viewBox="0 0 358 110" preserveAspectRatio="xMidYMid slice">
        <Rect width={358} height={110} fill="#ECEEEA" />
        <Path d="M0 70h358M0 30h358M90 0v110M220 0v110M300 0v110" stroke="#FFFFFF" strokeWidth={8} />
        <Rect x={236} y={40} width={56} height={22} rx={3} fill="#D5E8CF" />
        <Path d="M0 96c60-10 120 6 180-2s120-14 178-4v20H0z" fill="#CFE0EE" />
      </Svg>
      <View style={styles.pinAnchor}>
        <Animated.View style={[styles.pinRing, ringStyle]} />
        <Animated.View style={[styles.pin, pin]}>
          <View style={styles.pinDot} />
        </Animated.View>
      </View>
    </View>
  );
}

/** The design's sweep of light across the Place order button. */
function Shine() {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(withSequence(withTiming(0, { duration: 1800 }), withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.quad) })), -1);
  }, [t]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: interpolate(t.value, [0, 1], [-80, 420]) }, { skewX: "-18deg" }] }));
  return <Animated.View pointerEvents="none" style={[styles.shine, style]} />;
}

function Segmented({ value, onChange, canDeliver, canCollect }: { value: "DELIVERY" | "PICKUP"; onChange: (v: "DELIVERY" | "PICKUP") => void; canDeliver: boolean; canCollect: boolean }) {
  const [w, setW] = useState(0);
  const x = useDerivedValue(() => withSpring(value === "DELIVERY" ? 0 : 1, { damping: 15, stiffness: 200 }), [value]);
  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * (w / 2 - 4) }] }));
  return (
    <View style={styles.seg} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      <Animated.View style={[styles.segPill, { width: w / 2 - 4 }, pill]} />
      {(["DELIVERY", "PICKUP"] as const).map((m) => {
        const enabled = m === "DELIVERY" ? canDeliver : canCollect;
        return (
          <PressScale key={m} disabled={!enabled} onPress={() => onChange(m)} scaleTo={0.97} style={styles.segBtn} accessibilityState={{ selected: value === m, disabled: !enabled }}>
            <T style={[styles.segText, !enabled && { color: C.grey400 }]}>{m === "DELIVERY" ? "Delivery" : "Pickup"}</T>
          </PressScale>
        );
      })}
    </View>
  );
}

/** Next pickup/delivery slots: every 15 minutes, from 45 minutes out, for 4 hours. */
function slots(): Date[] {
  const start = new Date(Date.now() + 45 * 60_000);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
  return Array.from({ length: 16 }, (_, i) => new Date(start.getTime() + i * 15 * 60_000));
}
const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export function CheckoutScreen({ navigation }: RootScreen<"Checkout">) {
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const { shop: basketShop, lines, setQuantity, clear } = useBasket();
  const session = useSession();
  const address = useSelectedAddress();
  const shopsQ = useShops(searchPoint(address));
  const shop = shopsQ.data?.find((s) => s.id === basketShop?.id) ?? null;
  const menuQ = useShopMenu(basketShop?.id ?? "");

  const canDeliver = shop ? shop.delivery.available : menuQ.data?.listing.acceptsDelivery ?? true;
  const canCollect = shop ? shop.collection.available : menuQ.data?.listing.acceptsCollection ?? true;
  const [mode, setMode] = useState<"DELIVERY" | "PICKUP">(canDeliver ? "DELIVERY" : "PICKUP");
  const [when, setWhen] = useState<"now" | Date>("now");
  const [tip, setTip] = useState(1);
  const [placing, setPlacing] = useState(false);
  const idempotency = useRef<{ key: string; sig: string } | null>(null);

  const delivery = mode === "DELIVERY";
  const subtotal = basketSubtotal(lines);
  const deliveryFee = delivery ? shop?.delivery.fee ?? 0 : 0;
  const tipAmount = delivery ? TIPS[tip]! : 0;
  const total = round2(subtotal + deliveryFee + tipAmount);
  // The matched delivery zone's minimum (from GET efl/shops), else the shop's own.
  const minimum = Number(shop?.delivery.minOrder ?? menuQ.data?.store.directConfig?.minOrderForDelivery ?? 0);
  const underMinimum = delivery && minimum > 0 && subtotal < minimum;
  const prep = menuQ.data?.store.directConfig?.[delivery ? "deliveryPrepMinutes" : "collectionPrepMinutes"] ?? (delivery ? 30 : 15);
  // Prefer the API's window for this address: prep + driving for delivery,
  // the shop's ready time for collection.
  const etaWindow = delivery
    ? shop?.delivery.etaMinutes ?? { min: prep, max: prep + 10 }
    : shop?.collection.readyInMinutes
      ? { min: shop.collection.readyInMinutes, max: shop.collection.readyInMinutes + 5 }
      : { min: prep, max: prep + 5 };
  const slotList = useMemo(slots, []);

  if (!basketShop || lines.length === 0) {
    return (
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <RoundButton icon="back" label="Back" light onPress={() => navigation.goBack()} />
          <T v="h1">Basket</T>
        </View>
        <Animated.View entering={fadeUp(80)} style={styles.empty}>
          <TagMark size={64} />
          <T v="h3">Your basket is empty</T>
          <T v="sub" style={{ textAlign: "center", fontSize: 15 }}>Add something tasty from a shop near you.</T>
          <PressScale onPress={() => navigation.navigate("Tabs", { screen: "Home" })} style={styles.primarySmall}>
            <T style={styles.primaryText}>Find food</T>
          </PressScale>
        </Animated.View>
      </View>
    );
  }

  const place = async () => {
    if (!session.token) {
      navigation.navigate("Welcome");
      return;
    }
    if (!session.phoneVerified) {
      navigation.navigate("Phone", { then: "Checkout" });
      return;
    }
    if (delivery && !address) {
      navigation.navigate("Address");
      return;
    }
    const body: CheckoutBody = {
      idempotencyKey: "",
      fulfillmentType: mode,
      ...(delivery && address
        ? {
            deliveryAddress: {
              line1: address.line1,
              line2: [address.line2, address.instructions].filter(Boolean).join(" · ") || undefined,
              city: address.city,
              postcode: address.postcode,
              latitude: address.lat,
              longitude: address.lng,
            },
          }
        : {}),
      items: lines.map((l) => ({
        menuItemId: l.menuItemId,
        name: l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        // The option id and size let the server price each line exactly.
        modifiers: l.modifiers.map((m) => ({
          name: m.name,
          price: m.price,
          optionId: m.id,
          ...(m.depth ? { depth: m.depth } : {}),
          ...(m.path?.length ? { path: m.path } : {}),
          ...(m.parentOptionId ? { parentOptionId: m.parentOptionId } : {}),
        })),
        ...(l.sku ? { skuPlu: l.sku.plu, skuName: l.sku.name } : {}),
        ...(l.notes ? { notes: l.notes } : {}),
      })),
      subtotal,
      deliveryFee,
      tipAmount,
      total,
      ...(when !== "now" ? { scheduledFor: when.toISOString() } : {}),
    };
    // Same basket, same key: tapping again after a cancelled payment re-uses
    // the order instead of opening a second one.
    const sig = JSON.stringify({ ...body, idempotencyKey: "" });
    if (!idempotency.current || idempotency.current.sig !== sig) idempotency.current = { key: `efl-${Crypto.randomUUID()}`, sig };
    body.idempotencyKey = idempotency.current.key;

    setPlacing(true);
    try {
      const result = await checkout(basketShop.id, body);
      const c = session.customer;
      const outcome = await payForOrder(result, { name: c ? `${c.firstName} ${c.lastName}`.trim() : "", email: c?.email });
      if (outcome === "cancelled") return;
      clear();
      idempotency.current = null;
      void qc.invalidateQueries({ queryKey: ["orders"] });
      navigation.reset({ index: 1, routes: [{ name: "Tabs" }, { name: "Tracking", params: { orderId: result.orderId } }] });
    } catch (err) {
      const message = (err as Error).message;
      if (err instanceof ApiError && /confirm your mobile/i.test(message)) {
        navigation.navigate("Phone", { then: "Checkout" });
      } else {
        Alert.alert("Couldn't place your order", message);
      }
    } finally {
      setPlacing(false);
    }
  };

  let i = 0;
  const enter = () => fadeUp(i++ * 60, 14, 600);

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <RoundButton icon="back" label="Back" light onPress={() => navigation.goBack()} />
        <View>
          <T v="h1">Checkout</T>
          <T v="sub">{basketShop.name}{basketShop.area ? ` · ${basketShop.area}` : ""}</T>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Animated.View entering={enter()}>
          <Segmented value={mode} onChange={setMode} canDeliver={canDeliver} canCollect={canCollect} />
        </Animated.View>

        <Animated.View entering={enter()} style={styles.addrCard}>
          <MiniMap />
          <PressScale onPress={() => delivery && navigation.navigate("Address")} scaleTo={0.98} style={styles.addrRow}>
            <View style={{ flex: 1, gap: 2 }}>
              <T v="item" style={{ fontSize: 15 }}>
                {delivery ? address?.line1 ?? "Add a delivery address" : `Collect from ${basketShop.name}`}
              </T>
              <T v="sub">
                {delivery
                  ? address
                    ? [address.line2, address.city, address.instructions].filter(Boolean).join(" · ")
                    : "So the driver knows where to go"
                  : `${basketShop.area ?? ""}${basketShop.area ? " · " : ""}ready in ${etaWindow.min}–${etaWindow.max} min`}
              </T>
            </View>
            {delivery ? <Icon name="chevronRight" size={18} /> : null}
          </PressScale>
        </Animated.View>

        <Animated.View entering={enter()} style={{ gap: 10 }}>
          <View style={styles.whenGrid}>
            <PressScale onPress={() => setWhen("now")} style={[styles.whenCard, { borderColor: when === "now" ? C.ink : C.grey300 }]} scaleTo={0.97}>
              <T v="label">Standard</T>
              <T v="sub">{`${etaWindow.min}–${etaWindow.max} min`}</T>
            </PressScale>
            <PressScale onPress={() => setWhen(when === "now" ? slotList[0]! : when)} style={[styles.whenCard, { borderColor: when !== "now" ? C.ink : C.grey300 }]} scaleTo={0.97}>
              <T v="label">Schedule</T>
              <T v="sub">{when === "now" ? "Choose a time" : `Today ${hhmm(when)}`}</T>
            </PressScale>
          </View>
          {when !== "now" ? (
            <Animated.View entering={fadeUp(0, 8, 300)}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                {slotList.map((d) => {
                  const on = d.getTime() === when.getTime();
                  return (
                    <PressScale key={d.getTime()} onPress={() => setWhen(d)} style={[styles.slot, on && { backgroundColor: C.ink }]}>
                      <T style={[styles.slotText, on && { color: C.white }]}>{hhmm(d)}</T>
                    </PressScale>
                  );
                })}
              </ScrollView>
            </Animated.View>
          ) : null}
        </Animated.View>

        <Animated.View entering={enter()} style={{ gap: 12 }}>
          <T v="title">Your order</T>
          {lines.map((l) => (
            <Animated.View key={l.key} layout={undefined} style={styles.line}>
              <Photo uri={l.imageUrl} kind={foodKind(l.name)} radius={12} style={{ width: 52, height: 52 }} />
              <View style={{ flex: 1, gap: 2 }}>
                <T v="bodyStrong" style={{ fontSize: 14 }}>
                  {l.name}
                  {l.sku ? <T v="sub" style={{ fontSize: 14 }}>{` · ${l.sku.name}`}</T> : null}
                </T>
                {l.modifiers.length ? <T v="sub" numberOfLines={2}>{l.modifiers.map((m) => m.name).join(", ")}</T> : null}
                {l.notes ? <T v="sub" numberOfLines={1}>“{l.notes}”</T> : null}
                <T v="price" style={{ fontSize: 14 }}>{money(l.unitPrice * l.quantity)}</T>
              </View>
              <Stepper compact min={0} value={l.quantity} onChange={(n) => setQuantity(l.key, n)} />
            </Animated.View>
          ))}
        </Animated.View>

        {delivery ? (
          <Animated.View entering={enter()} style={{ gap: 10 }}>
            <T v="title">Add a tip</T>
            <T v="sub" style={{ marginTop: -6 }}>Your tip goes to the shop and its delivery team.</T>
            <View style={styles.tips}>
              {TIPS.map((v, idx) => (
                <TipChip key={v} label={v === 0 ? "None" : `£${v}`} on={idx === tip} onPress={() => setTip(idx)} />
              ))}
            </View>
          </Animated.View>
        ) : null}

        <Animated.View entering={enter()} style={styles.totals}>
          <Row label="Subtotal" value={money(subtotal)} />
          {delivery ? <Row label="Delivery" value={deliveryFee ? money(deliveryFee) : "Free"} /> : null}
          {delivery ? <Row label="Tip" value={money(tipAmount)} /> : null}
          <View style={[styles.rowBetween, { marginTop: 4 }]}>
            <T v="title">Total</T>
            <T v="title" style={{ fontVariant: ["tabular-nums"] }}>{money(total)}</T>
          </View>
          {underMinimum ? (
            <View style={styles.minimum}>
              <T style={{ fontFamily: F.bold, fontSize: 13 }}>Add {money(minimum - subtotal)} more for delivery ({money(minimum)} minimum)</T>
            </View>
          ) : null}
        </Animated.View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) + 4 }]}>
        <View style={styles.payRow}>
          <View style={styles.payBadge}>
            <T style={{ color: C.white, fontFamily: F.bold, fontSize: 10 }}>Pay</T>
          </View>
          <T v="bodyStrong" style={{ fontSize: 14, flex: 1 }}>
            {Platform.OS === "ios" ? "Apple Pay or card" : "Google Pay or card"}
          </T>
          <Icon name="lock" size={16} color={C.grey600} />
        </View>
        <PressScale
          onPress={place}
          disabled={placing || underMinimum || basketCount(lines) === 0}
          haptic
          scaleTo={0.97}
          style={[styles.place, (underMinimum || placing) && { opacity: 0.6 }]}
          accessibilityLabel={`Place order, ${money(total)}`}
        >
          <Shine />
          {placing ? <ActivityIndicator color={C.white} /> : <T style={styles.placeText}>Place order · {money(total)}</T>}
        </PressScale>
      </View>
    </View>
  );
}

function TipChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const p = useDerivedValue(() => withSpring(on ? 1 : 0, MOTION.bouncy), [on]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: 1 + p.value * 0.04 }] }));
  return (
    <Animated.View style={[{ flex: 1 }, style]}>
      <PressScale onPress={onPress} accessibilityState={{ selected: on }} style={[styles.tip, on && { backgroundColor: C.ink }]} haptic>
        <T style={[styles.tipText, on && { color: C.white }]}>{label}</T>
      </PressScale>
    </Animated.View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.rowBetween}>
      <T v="body" style={{ color: C.grey600, fontSize: 14 }}>{label}</T>
      <T v="body" style={{ fontSize: 14, fontVariant: ["tabular-nums"] }}>{value}</T>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.white },
  header: { paddingHorizontal: 16, paddingBottom: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  scroll: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24, gap: 18 },
  seg: { height: 48, borderRadius: 24, backgroundColor: C.grey100, flexDirection: "row", padding: 4 },
  segPill: { position: "absolute", top: 4, left: 4, height: 40, borderRadius: 20, backgroundColor: C.white, ...shadow.soft },
  segBtn: { flex: 1, alignItems: "center", justifyContent: "center" },
  segText: { fontFamily: F.bold, fontSize: 14, color: C.ink },
  addrCard: { borderRadius: 18, overflow: "hidden", borderWidth: 1, borderColor: C.grey200 },
  addrRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 10, backgroundColor: C.white },
  pinAnchor: { position: "absolute", left: "50%", top: 30, marginLeft: -12, width: 24, height: 40, alignItems: "center" },
  pinRing: { position: "absolute", top: 11, width: 28, height: 28, borderRadius: 14, backgroundColor: C.ink },
  pin: { width: 24, height: 24, borderTopLeftRadius: 12, borderTopRightRadius: 12, borderBottomRightRadius: 12, borderBottomLeftRadius: 2, backgroundColor: C.ink, alignItems: "center", justifyContent: "center" },
  pinDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.lime },
  whenGrid: { flexDirection: "row", gap: 10 },
  whenCard: { flex: 1, borderRadius: 16, borderWidth: 2, padding: 12, gap: 2 },
  slot: { height: 40, borderRadius: 20, paddingHorizontal: 14, justifyContent: "center", backgroundColor: C.grey100 },
  slotText: { fontFamily: F.semibold, fontSize: 14, color: C.ink },
  line: { flexDirection: "row", alignItems: "center", gap: 12 },
  tips: { flexDirection: "row", gap: 8 },
  tip: { height: 44, borderRadius: 22, backgroundColor: C.grey100, alignItems: "center", justifyContent: "center" },
  tipText: { fontFamily: F.bold, fontSize: 14, color: C.ink },
  totals: { gap: 8, borderTopWidth: 1, borderTopColor: C.grey200, paddingTop: 16 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  minimum: { alignSelf: "flex-start", marginTop: 4, backgroundColor: C.lime, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  footer: { paddingTop: 12, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: C.grey200, gap: 10, backgroundColor: C.white },
  payRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 2 },
  payBadge: { width: 40, height: 26, borderRadius: 6, backgroundColor: C.ink, alignItems: "center", justifyContent: "center" },
  place: { height: 56, borderRadius: 28, backgroundColor: C.ink, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  placeText: { fontFamily: F.bold, fontSize: 17, color: C.white },
  shine: { position: "absolute", top: 0, bottom: 0, left: 0, width: 60, backgroundColor: "rgba(255,255,255,0.16)" },
  empty: { alignItems: "center", gap: 12, paddingHorizontal: 32, paddingTop: 80 },
  primarySmall: { marginTop: 8, height: 48, borderRadius: 24, backgroundColor: C.ink, paddingHorizontal: 24, justifyContent: "center" },
  primaryText: { color: C.white, fontFamily: F.bold, fontSize: 15 },
});
