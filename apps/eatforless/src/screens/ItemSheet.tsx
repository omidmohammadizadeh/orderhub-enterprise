// 4 · Item options — a springy bottom sheet: the photo, sizes, every modifier
// group (nested ones open under the option that unlocks them), quantity and a
// live price. Selection and pricing use the same shared functions as the web
// storefront and the server's re-pricing (packages/shared), so the price shown
// here is the price charged.

import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Keyboard, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  FadeIn,
  LinearTransition,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { calculateCartItem, extractSizeKey } from "@shared/menu-pricing";
import {
  adjustModifierQuantity,
  buildModifierTree,
  collectSelectedModifiers,
  findUnmetRequirements,
  indexGroups,
  toggleModifierSelection,
  type ModifierTreeNode,
  type NestableGroup,
} from "@shared/nested-modifiers";
import { useShopMenu } from "@/api/hooks";
import type { MenuItem, ProductSku } from "@/api/types";
import { Stepper } from "@/components/Bits";
import { Icon } from "@/components/Icon";
import { Photo } from "@/components/Photo";
import { PressScale } from "@/components/PressScale";
import { T } from "@/components/T";
import { activeGroups, foodKind, isOrderable } from "@/lib/menu";
import { money, toNumber } from "@/lib/money";
import type { RootScreen } from "@/navigation/types";
import { useBasket } from "@/state/basket";
import { C, F, MOTION } from "@/theme";

const SHEET_SPRING = { damping: 19, stiffness: 190, mass: 0.9 };

// ── Selection controls ─────────────────────────────────────────────────────

function Radio({ on }: { on: boolean }) {
  const p = useDerivedValue(() => withSpring(on ? 1 : 0, { damping: 10, stiffness: 300 }), [on]);
  const dot = useAnimatedStyle(() => ({ transform: [{ scale: p.value }] }));
  return (
    <View style={[styles.radio, { borderColor: on ? C.ink : C.grey400 }]}>
      <Animated.View style={[styles.radioDot, dot]} />
    </View>
  );
}

function Check({ on }: { on: boolean }) {
  const p = useDerivedValue(() => withSpring(on ? 1 : 0, { damping: 10, stiffness: 300 }), [on]);
  const tick = useAnimatedStyle(() => ({ transform: [{ scale: p.value }] }));
  return (
    <View style={[styles.check, on && { backgroundColor: C.ink }]}>
      <Animated.View style={tick}>
        <Icon name="check" size={14} color={C.lime} strokeWidth={3.5} />
      </Animated.View>
    </View>
  );
}

function GroupHeader({ title, sub, required, satisfied, shake }: { title: string; sub: string; required: boolean; satisfied: boolean; shake: number }) {
  const x = useSharedValue(0);
  useEffect(() => {
    if (shake > 0) x.value = withSequence(...[-8, 8, -6, 6, -3, 0].map((v) => withTiming(v, { duration: 55 })));
  }, [shake, x]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const badge = !required ? null : satisfied ? { text: "Done", bg: C.lime, ink: C.ink } : { text: "Required", bg: shake > 0 ? C.ink : C.grey200, ink: shake > 0 ? C.lime : C.ink };
  return (
    <Animated.View style={[styles.groupHead, style]}>
      <View style={{ flex: 1, gap: 2 }}>
        <T v="title">{title}</T>
        <T v="sub">{sub}</T>
      </View>
      {badge ? (
        <Animated.View layout={LinearTransition.springify().damping(16)} style={[styles.reqBadge, { backgroundColor: badge.bg }]}>
          <T style={{ fontFamily: F.bold, fontSize: 12, color: badge.ink }}>{badge.text}</T>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

function ruleText(min: number, max: number | null | undefined, variant: boolean): string {
  if (variant) return min > 0 ? "Pick 1" : "Optional · pick 1";
  if (max && min > 0) return min === max ? `Pick ${min}` : `Pick ${min}–${max}`;
  if (max) return `Optional · up to ${max}`;
  return min > 0 ? `Pick at least ${min}` : "Optional";
}

function Groups({
  nodes,
  onToggle,
  onStep,
  shakeKey,
  registerRef,
}: {
  nodes: ModifierTreeNode[];
  onToggle: (node: ModifierTreeNode, optionId: string) => void;
  onStep: (node: ModifierTreeNode, optionId: string, delta: number) => void;
  shakeKey: Record<string, number>;
  registerRef: (key: string, view: View | null) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const variant = (node.group.selectionType ?? "VARIANT") === "VARIANT";
        const min = node.group.minSelections ?? 0;
        const picked = node.options.reduce((n, o) => n + o.quantity, 0);
        const nested = node.depth > 0;
        return (
          <Animated.View
            key={node.key}
            entering={nested ? FadeIn.duration(260) : undefined}
            layout={LinearTransition.springify().damping(18)}
            style={nested ? styles.nested : undefined}
            ref={(v: any) => registerRef(node.key, v)}
          >
            {nested ? (
              <View style={styles.nestedHead}>
                <T style={{ fontFamily: F.heavy, fontSize: 15 }}>{node.group.name}</T>
                <T v="sub">{ruleText(min, node.group.maxSelections, variant)}{min > 0 ? (picked >= min ? " · done" : " · required") : ""}</T>
              </View>
            ) : (
              <GroupHeader
                title={node.group.name}
                sub={ruleText(min, node.group.maxSelections, variant)}
                required={min > 0}
                satisfied={picked >= min}
                shake={shakeKey[node.key] ?? 0}
              />
            )}
            <View style={{ paddingHorizontal: nested ? 0 : 16 }}>
              {node.options.map((entry) => {
                const dup = !!node.group.allowDuplicateSelections && !variant;
                return (
                  <View key={entry.option.id}>
                    <PressScale
                      onPress={() => onToggle(node, entry.option.id)}
                      scaleTo={0.98}
                      accessibilityRole={variant ? "radio" : "checkbox"}
                      accessibilityState={{ checked: entry.selected }}
                      style={styles.optRow}
                    >
                      <View style={{ flex: 1, gap: 2 }}>
                        <T v="bodyStrong">{entry.option.name}</T>
                        {entry.price > 0 ? <T v="sub">+{money(entry.price)}</T> : null}
                      </View>
                      {dup && entry.quantity > 0 ? (
                        <Stepper compact min={0} value={entry.quantity} onChange={(n) => onStep(node, entry.option.id, n - entry.quantity)} />
                      ) : variant ? (
                        <Radio on={entry.selected} />
                      ) : (
                        <Check on={entry.selected} />
                      )}
                    </PressScale>
                    {entry.selected && entry.children.length > 0 ? (
                      <Groups nodes={entry.children} onToggle={onToggle} onStep={onStep} shakeKey={shakeKey} registerRef={registerRef} />
                    ) : null}
                  </View>
                );
              })}
            </View>
          </Animated.View>
        );
      })}
    </>
  );
}

// ── The sheet ──────────────────────────────────────────────────────────────

export function ItemSheet({ navigation, route }: RootScreen<"Item">) {
  const { shop, itemId } = route.params;
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const menuQ = useShopMenu(shop.id);
  const add = useBasket((s) => s.add);
  const replaceWith = useBasket((s) => s.replaceWith);

  const store = menuQ.data?.store;
  const item: MenuItem | undefined = useMemo(
    () => store?.menu?.categories.flatMap((c) => c.items).find((r) => r.item.id === itemId)?.item,
    [store, itemId],
  );
  const catalogue = store?.brandModifierGroups ?? [];
  const skus: ProductSku[] = item?.productSkus ?? [];
  const multiSku = skus.length > 1;

  const [sku, setSku] = useState<ProductSku | null>(skus.length >= 1 ? skus[0]! : null);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState("");
  const [shake, setShake] = useState<Record<string, number>>({});
  const groupRefs = useRef<Record<string, View | null>>({});
  const contentRef = useRef<View>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!sku && skus.length >= 1) setSku(skus[0]!);
  }, [skus, sku]);

  const sizeKey = sku ? extractSizeKey(sku.name) : null;
  const roots = useMemo(() => (item ? activeGroups(item, sku, catalogue) : []), [item, sku, catalogue]);
  const groupsById = useMemo(
    () => indexGroups(roots as unknown as NestableGroup[], catalogue as unknown as NestableGroup[]),
    [roots, catalogue],
  );
  const nodes = useMemo(
    () => buildModifierTree({ rootGroups: roots as unknown as NestableGroup[], groupsById, selections, sizeKey, audience: "customer" }),
    [roots, groupsById, selections, sizeKey],
  );
  const selected = useMemo(() => collectSelectedModifiers(nodes), [nodes]);
  const unmet = useMemo(() => findUnmetRequirements(nodes), [nodes]);
  const base = sku ? Number(sku.price) : toNumber(item?.basePrice);
  const price = calculateCartItem({ basePrice: base, modifiers: selected, quantity: qty });

  // ── Sheet motion ──
  const sheetH = Math.min(height - insets.top - 24, 790);
  const y = useSharedValue(sheetH);
  const scrim = useSharedValue(0);
  const food = useSharedValue(0);
  useEffect(() => {
    y.value = withSpring(0, SHEET_SPRING);
    scrim.value = withTiming(1, { duration: 320 });
    food.value = withSpring(1, { damping: 9, stiffness: 120, mass: 0.8 });
  }, [y, scrim, food]);

  const close = () => {
    Keyboard.dismiss();
    scrim.value = withTiming(0, { duration: 220 });
    y.value = withTiming(sheetH, { duration: 260, easing: Easing.in(Easing.quad) }, (done) => {
      if (done) runOnJS(navigation.goBack)();
    });
  };

  // One gesture object per detector (handle, photo) — RNGH won't share one.
  const makeDrag = () => Gesture.Pan()
    .activeOffsetY(8)
    .onUpdate((e) => {
      y.value = Math.max(0, e.translationY);
      scrim.value = 1 - Math.min(1, e.translationY / sheetH);
    })
    .onEnd((e) => {
      if (e.translationY > 140 || e.velocityY > 900) runOnJS(close)();
      else {
        y.value = withSpring(0, SHEET_SPRING);
        scrim.value = withTiming(1);
      }
    });
  const dragHandle = useMemo(makeDrag, []);
  const dragPhoto = useMemo(makeDrag, []);

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrim.value }));
  const foodStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, food.value * 1.5),
    transform: [{ scale: 0.6 + food.value * 0.4 }, { rotate: `${-40 * (1 - food.value)}deg` }],
  }));

  const onToggle = (node: ModifierTreeNode, optionId: string) => {
    void Haptics.selectionAsync();
    setSelections((prev) =>
      toggleModifierSelection(prev, {
        key: node.key,
        optionId,
        selectionType: node.group.selectionType ?? "VARIANT",
        maxSelections: node.group.maxSelections,
        minSelections: node.group.minSelections,
        allowDuplicates: node.group.allowDuplicateSelections,
      }),
    );
  };
  const onStep = (node: ModifierTreeNode, optionId: string, delta: number) =>
    setSelections((prev) => adjustModifierQuantity(prev, { key: node.key, optionId, delta, maxSelections: node.group.maxSelections }));

  const submit = () => {
    if (!item) return;
    if (unmet.length > 0) {
      // Point at the first unanswered question rather than just refusing.
      const first = unmet[0]!;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setShake((s) => ({ ...s, [first.key]: (s[first.key] ?? 0) + 1 }));
      const target = groupRefs.current[first.key];
      if (target && contentRef.current) {
        target.measureLayout(contentRef.current, (_x, gy) => scrollRef.current?.scrollTo({ y: Math.max(0, gy - 12), animated: true }));
      }
      return;
    }
    const line = {
      menuItemId: item.id,
      name: item.name,
      imageUrl: item.imageUrl ?? null,
      unitPrice: price.unitPrice,
      quantity: qty,
      modifiers: selected,
      sku: sku ? { name: sku.name, plu: sku.plu } : null,
      notes: notes.trim() || undefined,
    };
    const basketShop = { id: shop.id, name: shop.name, area: shop.area };
    if (add(basketShop, line)) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      close();
    } else {
      Alert.alert("Start a new basket?", "Your basket has food from another shop. Clear it and add this instead?", [
        { text: "Keep it", style: "cancel" },
        {
          text: "New basket",
          style: "destructive",
          onPress: () => {
            replaceWith(basketShop, line);
            close();
          },
        },
      ]);
    }
  };

  const orderable = item ? isOrderable(item) && store?.isOpen !== false && !store?.closed : false;

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: C.scrim }, scrimStyle]}>
        <PressScale accessibilityLabel="Close" style={StyleSheet.absoluteFill} scaleTo={1} onPress={close} />
      </Animated.View>

      <Animated.View style={[styles.sheet, { height: sheetH }, sheetStyle]}>
        <GestureDetector gesture={dragHandle}>
          <View style={styles.handleArea}>
            <View style={styles.handle} />
          </View>
        </GestureDetector>

        {!item ? (
          <View style={{ padding: 24 }}>
            <T v="sub">{menuQ.isLoading ? "Loading…" : "This item isn't on the menu any more."}</T>
          </View>
        ) : (
          <>
            <ScrollView
              ref={scrollRef}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: 20 }}
              onScrollEndDrag={(e) => {
                if (e.nativeEvent.contentOffset.y < -90) close();
              }}
            >
              <View ref={contentRef} collapsable={false}>
              <GestureDetector gesture={dragPhoto}>
                <View style={styles.photoBox}>
                  <Animated.View style={[StyleSheet.absoluteFill, foodStyle]}>
                    <Photo uri={item.imageUrl} kind={foodKind(item.name)} style={StyleSheet.absoluteFillObject} />
                  </Animated.View>
                  <PressScale onPress={close} accessibilityLabel="Close" style={styles.closeBtn}>
                    <Icon name="close" size={18} />
                  </PressScale>
                </View>
              </GestureDetector>

              <View style={styles.intro}>
                <T v="hero" style={{ fontSize: 26 }}>{item.name}</T>
                {item.description ? <T v="sub" style={{ fontSize: 14, lineHeight: 20 }}>{item.description}</T> : null}
                {item.allergens?.length ? (
                  <View style={styles.allergens}>
                    <T v="small">Allergens: {item.allergens.join(", ")}</T>
                  </View>
                ) : (
                  <View style={styles.allergens}>
                    <T v="small">Allergies? Ask the shop before you order.</T>
                  </View>
                )}
              </View>

              <View>
                {multiSku ? (
                  <View>
                    <GroupHeader title="Choose a size" sub="Pick 1" required satisfied={!!sku} shake={0} />
                    <View style={{ paddingHorizontal: 16 }}>
                      {skus.map((s) => (
                        <PressScale
                          key={s.plu}
                          scaleTo={0.98}
                          accessibilityRole="radio"
                          accessibilityState={{ checked: sku?.plu === s.plu }}
                          onPress={() => {
                            void Haptics.selectionAsync();
                            setSku(s);
                          }}
                          style={styles.optRow}
                        >
                          <View style={{ flex: 1, gap: 2 }}>
                            <T v="bodyStrong">{s.name}</T>
                            <T v="sub">{money(s.price)}</T>
                          </View>
                          <Radio on={sku?.plu === s.plu} />
                        </PressScale>
                      ))}
                    </View>
                  </View>
                ) : null}

                <Groups
                  nodes={nodes}
                  onToggle={onToggle}
                  onStep={onStep}
                  shakeKey={shake}
                  registerRef={(key, v) => {
                    groupRefs.current[key] = v;
                  }}
                />

                <View style={{ paddingHorizontal: 16, paddingTop: 18, gap: 8 }}>
                  <T v="title">Note for the shop</T>
                  <TextInput
                    value={notes}
                    onChangeText={setNotes}
                    placeholder="e.g. no onions, well done"
                    placeholderTextColor={C.grey500}
                    maxLength={140}
                    style={styles.notes}
                  />
                </View>
              </View>
              </View>
            </ScrollView>

            <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 14) + 6 }]}>
              <Stepper value={qty} onChange={setQty} />
              <PressScale
                onPress={submit}
                disabled={!orderable}
                haptic
                accessibilityLabel={`Add ${qty} to basket, ${money(price.lineTotal)}`}
                style={[styles.addBtn, (!orderable || unmet.length > 0) && { backgroundColor: orderable ? "#3A3A3A" : C.grey400 }]}
              >
                <T style={styles.addText}>{orderable ? `Add ${qty}` : "Not available"}</T>
                {orderable ? <T style={[styles.addText, { fontVariant: ["tabular-nums"] }]}>{money(price.lineTotal)}</T> : null}
              </PressScale>
            </View>
          </>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: C.white,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: "hidden",
  },
  handleArea: { alignItems: "center", paddingTop: 8, paddingBottom: 4 },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: "#D6D6D6" },
  photoBox: { height: 200, marginHorizontal: 16, marginTop: 8, borderRadius: 20, overflow: "hidden", backgroundColor: "#F5E6D6" },
  closeBtn: { position: "absolute", top: 12, right: 12, width: 40, height: 40, borderRadius: 20, backgroundColor: C.white, alignItems: "center", justifyContent: "center" },
  intro: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 4, gap: 6 },
  allergens: { alignSelf: "flex-start", marginTop: 4, borderWidth: 1, borderColor: C.grey300, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5 },
  groupHead: {
    marginTop: 14,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
    backgroundColor: C.grey50,
    flexDirection: "row",
    alignItems: "center",
  },
  reqBadge: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5 },
  optRow: { flexDirection: "row", alignItems: "center", paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: C.line, gap: 12 },
  radio: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: C.ink },
  check: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: C.ink, alignItems: "center", justifyContent: "center" },
  nested: { marginLeft: 14, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: C.grey200, marginBottom: 6 },
  nestedHead: { paddingTop: 12, gap: 2 },
  notes: {
    height: 48,
    borderRadius: 14,
    backgroundColor: C.grey100,
    paddingHorizontal: 14,
    fontFamily: F.regular,
    fontSize: 15,
    color: C.ink,
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: C.grey200,
    paddingTop: 14,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.white,
  },
  addBtn: {
    flex: 1,
    height: 52,
    borderRadius: 26,
    backgroundColor: C.ink,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
  },
  addText: { fontFamily: F.bold, fontSize: 16, color: C.white },
});
