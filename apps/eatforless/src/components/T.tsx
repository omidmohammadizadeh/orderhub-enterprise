import { StyleSheet, Text, type TextProps } from "react-native";
import { C, F } from "@/theme";

const variants = StyleSheet.create({
  hero: { fontFamily: F.display, fontSize: 28, letterSpacing: -0.7, color: C.ink },
  h1: { fontFamily: F.display, fontSize: 24, letterSpacing: -0.5, color: C.ink },
  h2: { fontFamily: F.display, fontSize: 22, letterSpacing: -0.45, color: C.ink },
  h3: { fontFamily: F.display, fontSize: 20, letterSpacing: -0.4, color: C.ink },
  title: { fontFamily: F.heavy, fontSize: 17, color: C.ink },
  item: { fontFamily: F.bold, fontSize: 16, color: C.ink },
  body: { fontFamily: F.regular, fontSize: 15, color: C.ink },
  bodyStrong: { fontFamily: F.semibold, fontSize: 15, color: C.ink },
  sub: { fontFamily: F.regular, fontSize: 13, color: C.grey600, lineHeight: 18 },
  small: { fontFamily: F.semibold, fontSize: 12, color: C.grey600 },
  label: { fontFamily: F.bold, fontSize: 14, color: C.ink },
  price: { fontFamily: F.bold, fontSize: 15, color: C.ink, fontVariant: ["tabular-nums"] },
});

export type TVariant = keyof typeof variants;

/** Text in one of the design's type styles. Display sizes ignore Dynamic Type
 *  past 1.3× so headings don't wrap into the hero. */
export function T({ v = "body", style, ...rest }: TextProps & { v?: TVariant }) {
  const isDisplay = v === "hero" || v === "h1" || v === "h2" || v === "h3";
  return <Text maxFontSizeMultiplier={isDisplay ? 1.3 : 1.6} {...rest} style={[variants[v], style]} />;
}
