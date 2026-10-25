// Entering animations shared by every screen: the design's "fade up" (opacity
// 0 → 1, 18px → 0 on cubic-bezier(.2,.8,.2,1)), staggered by index.

import { Easing, withDelay, withTiming } from "react-native-reanimated";

const EASE = Easing.bezier(0.2, 0.8, 0.2, 1);

export function fadeUp(delay = 0, distance = 18, duration = 650) {
  return () => {
    "worklet";
    return {
      initialValues: { opacity: 0, transform: [{ translateY: distance }] },
      animations: {
        opacity: withDelay(delay, withTiming(1, { duration, easing: EASE })),
        transform: [{ translateY: withDelay(delay, withTiming(0, { duration, easing: EASE })) }],
      },
    };
  };
}

/** For list rows: a short stagger, capped so long lists don't crawl in. */
export const stagger = (index: number, step = 60, base = 80) => base + Math.min(index, 8) * step;
