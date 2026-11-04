// The shop's logo in a white disc, sat on its banner like every delivery app
// does. Nothing at all when the shop has no logo — an empty disc looks broken.

import { Image } from "expo-image";
import { useState } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { C } from "@/theme";

export function ShopLogo({ uri, size = 44, style }: { uri?: string | null; size?: number; style?: StyleProp<ViewStyle> }) {
  const [failed, setFailed] = useState(false);
  if (!uri || failed) return null;
  return (
    <View style={[styles.disc, { width: size, height: size, borderRadius: size / 2 }, style]}>
      <Image
        source={{ uri }}
        style={{ width: size - 6, height: size - 6, borderRadius: (size - 6) / 2 }}
        contentFit="cover"
        cachePolicy="memory-disk"
        recyclingKey={uri}
        accessibilityIgnoresInvertColors
        onError={() => setFailed(true)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  disc: {
    backgroundColor: C.white,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.16,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
});
