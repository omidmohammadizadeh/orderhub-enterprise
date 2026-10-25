// A food photo from the shop's menu, with the illustrated tile behind it — so
// a missing or failed image still looks designed, and a slow one fades in over
// something rather than over grey.

import { Image } from "expo-image";
import { useState } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import type { FoodKind } from "@/lib/menu";
import { FoodArt } from "./FoodArt";

type Props = { uri?: string | null; kind: FoodKind; style?: ViewStyle; radius?: number };

export function Photo({ uri, kind, style, radius = 0 }: Props) {
  const [failed, setFailed] = useState(false);
  return (
    <View style={[{ borderRadius: radius, overflow: "hidden" }, style]}>
      <FoodArt kind={kind} style={StyleSheet.absoluteFillObject} />
      {uri && !failed ? (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={260}
          cachePolicy="memory-disk"
          recyclingKey={uri}
          onError={() => setFailed(true)}
        />
      ) : null}
    </View>
  );
}
