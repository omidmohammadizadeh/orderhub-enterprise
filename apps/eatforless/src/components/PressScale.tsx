// The press feedback used on every tappable surface: a quick spring down to
// 0.96 and back, run on the UI thread, plus an optional light haptic.

import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { MOTION } from "@/theme";

const APressable = Animated.createAnimatedComponent(Pressable);

type Props = Omit<PressableProps, "style" | "children"> & {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  scaleTo?: number;
  haptic?: boolean;
};

export function PressScale({ style, children, scaleTo = MOTION.pressScale, haptic, onPressIn, onPressOut, onPress, ...rest }: Props) {
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <APressable
      accessibilityRole="button"
      hitSlop={6}
      {...rest}
      onPressIn={(e) => {
        scale.value = withSpring(scaleTo, MOTION.press);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.value = withSpring(1, MOTION.press);
        onPressOut?.(e);
      }}
      onPress={(e) => {
        if (haptic) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress?.(e);
      }}
      style={[style, animated]}
    >
      {children}
    </APressable>
  );
}
