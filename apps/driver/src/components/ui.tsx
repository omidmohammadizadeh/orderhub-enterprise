// Shared building blocks for the driver app's dark UI.

import { ComponentProps, ReactNode, useEffect, useRef } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { C, R, shadow } from "@/theme";

export type IconName = ComponentProps<typeof Ionicons>["name"];

export function Icon({ name, size = 20, color = C.text }: { name: IconName; size?: number; color?: string }) {
  return <Ionicons name={name} size={size} color={color} />;
}

// Pressed state shrinks a touch — the only feedback a gloved thumb gets.
const pressed = ({ pressed: p }: { pressed: boolean }) => (p ? { transform: [{ scale: 0.96 }], opacity: 0.85 } : null);

export function RoundButton({
  icon,
  onPress,
  size = 48,
  color = C.text,
  bg = C.glass,
  badge,
  disabled,
  style,
  accessibilityLabel,
}: {
  icon: IconName;
  onPress?: () => void;
  size?: number;
  color?: string;
  bg?: string;
  badge?: number;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={(s) => [
        styles.round,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: bg, opacity: disabled ? 0.4 : 1 },
        shadow,
        style,
        pressed(s),
      ]}
    >
      <Icon name={icon} size={Math.round(size * 0.46)} color={color} />
      {!!badge && badge > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge > 9 ? "9+" : badge}</Text>
        </View>
      )}
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  icon,
  tone = "primary",
  busy,
  disabled,
  style,
}: {
  label: string;
  onPress?: () => void;
  icon?: IconName;
  tone?: "primary" | "go" | "ghost" | "danger" | "light";
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = TONES[tone];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={(s) => [
        styles.btn,
        { backgroundColor: t.bg, borderColor: t.border, opacity: disabled ? 0.45 : 1 },
        style,
        pressed(s),
      ]}
    >
      {busy ? (
        <ActivityIndicator color={t.fg} />
      ) : (
        <>
          {icon && <Icon name={icon} size={19} color={t.fg} />}
          <Text style={[styles.btnText, { color: t.fg }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

const TONES = {
  primary: { bg: C.brand, fg: "#fff", border: C.brand },
  go: { bg: C.go, fg: C.onAccent, border: C.go },
  light: { bg: C.text, fg: C.bg, border: C.text },
  ghost: { bg: C.surface2, fg: C.text, border: C.border },
  danger: { bg: "rgba(255,77,79,0.12)", fg: C.danger, border: "rgba(255,77,79,0.35)" },
} as const;

/** Top bar for the full-screen sub-pages (orders, cash-up, chat, profile). */
export function Header({
  title,
  subtitle,
  onBack,
  right,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  right?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      <Pressable onPress={onBack} hitSlop={12} style={(s) => [styles.headerBack, pressed(s)]} accessibilityLabel="Back">
        <Icon name="chevron-back" size={22} />
      </Pressable>
      <View style={{ flex: 1, alignItems: "center" }}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        {!!subtitle && (
          <Text style={styles.headerSub} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      <View style={{ width: 40, alignItems: "flex-end" }}>{right}</View>
    </View>
  );
}

export function Segmented<K extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: K; label: string }[];
  value: K;
  onChange: (k: K) => void;
}) {
  return (
    <View style={styles.seg}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable key={o.key} onPress={() => onChange(o.key)} style={[styles.segItem, on && styles.segItemOn]}>
            <Text style={[styles.segText, on && styles.segTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A soft looping pulse — the "live" heartbeat behind the online dot and the
 *  driver's own position. Native-driven, so it costs the JS thread nothing. */
export function Pulse({ color, size, style }: { color: string; size: number; style?: StyleProp<ViewStyle> }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(v, { toValue: 1, duration: 1800, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
          transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }],
        },
        style,
      ]}
    />
  );
}

export function StatusDot({ color, live }: { color: string; live?: boolean }) {
  return (
    <View style={{ width: 12, height: 12, alignItems: "center", justifyContent: "center" }}>
      {live && <Pulse color={color} size={22} />}
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
    </View>
  );
}

const styles = StyleSheet.create({
  round: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: C.border },
  badge: {
    position: "absolute",
    top: -3,
    right: -3,
    minWidth: 19,
    height: 19,
    borderRadius: 10,
    paddingHorizontal: 5,
    backgroundColor: C.danger,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: C.bg,
  },
  badgeText: { color: "#fff", fontSize: 10, fontWeight: "800" },
  btn: {
    height: 54,
    borderRadius: R.md,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 18,
  },
  btnText: { fontSize: 16, fontWeight: "800", letterSpacing: 0.2 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: C.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  headerBack: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { color: C.text, fontSize: 17, fontWeight: "800" },
  headerSub: { color: C.textDim, fontSize: 12, marginTop: 1 },
  seg: {
    flexDirection: "row",
    backgroundColor: C.surface,
    borderRadius: R.md,
    padding: 4,
    borderWidth: 1,
    borderColor: C.border,
  },
  segItem: { flex: 1, paddingVertical: 9, borderRadius: R.sm, alignItems: "center" },
  segItemOn: { backgroundColor: C.surface3 },
  segText: { color: C.textMute, fontWeight: "700", fontSize: 13 },
  segTextOn: { color: C.text },
});
