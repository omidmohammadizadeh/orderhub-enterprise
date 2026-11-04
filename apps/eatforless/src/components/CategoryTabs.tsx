// Sticky category tabs with a springy underline that slides and stretches to
// the active tab, and a tab row that scrolls itself to keep that tab in view.

import { useEffect, useRef } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import Animated, { interpolateColor, useAnimatedStyle, useDerivedValue, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { C, F, MOTION } from "@/theme";
import { PressScale } from "./PressScale";

type Props = { titles: string[]; active: number; onPick: (index: number) => void };

function TabLabel({ title, on }: { title: string; on: boolean }) {
  const p = useDerivedValue(() => withTiming(on ? 1 : 0, { duration: 250 }), [on]);
  const style = useAnimatedStyle(() => ({ color: interpolateColor(p.value, [0, 1], [C.grey500, C.ink]) }));
  return <Animated.Text style={[styles.label, style]}>{title}</Animated.Text>;
}

export function CategoryTabs({ titles, active, onPick }: Props) {
  const scroller = useRef<ScrollView>(null);
  const layouts = useRef<Array<{ x: number; width: number }>>([]);
  const x = useSharedValue(16);
  const w = useSharedValue(0);

  const moveTo = (index: number, animate: boolean) => {
    const l = layouts.current[index];
    if (!l) return;
    x.value = animate ? withSpring(l.x, MOTION.underline) : l.x;
    w.value = animate ? withSpring(l.width, MOTION.underline) : l.width;
    scroller.current?.scrollTo({ x: Math.max(0, l.x - 60), animated: animate });
  };

  useEffect(() => {
    moveTo(active, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const underline = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }], width: w.value }));

  return (
    <View style={styles.wrap}>
      <ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {titles.map((t, i) => (
          <PressScale
            key={`${t}-${i}`}
            onPress={() => onPick(i)}
            accessibilityRole="tab"
            accessibilityState={{ selected: i === active }}
            style={styles.tab}
            scaleTo={0.94}
            onLayout={(e) => {
              layouts.current[i] = { x: e.nativeEvent.layout.x, width: e.nativeEvent.layout.width };
              if (i === active) moveTo(i, false);
            }}
          >
            <TabLabel title={t} on={i === active} />
          </PressScale>
        ))}
        <Animated.View style={[styles.underline, underline]} />
      </ScrollView>
    </View>
  );
}

export const TABS_HEIGHT = 49;

const styles = StyleSheet.create({
  wrap: { height: TABS_HEIGHT, backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.grey200 },
  row: { paddingHorizontal: 16 },
  tab: { height: 48, paddingHorizontal: 14, justifyContent: "center" },
  label: { fontFamily: F.bold, fontSize: 14 },
  underline: { position: "absolute", left: 0, bottom: 0, height: 3, borderRadius: 2, backgroundColor: C.ink },
});
