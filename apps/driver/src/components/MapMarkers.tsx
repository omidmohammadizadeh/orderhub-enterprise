// Map pins for the dark map.
//
// Android draws a custom marker by snapshotting its view to a bitmap. If the
// snapshot is taken before the view has its final size — an icon font still
// loading, a border not laid out yet — the bitmap keeps that size and the pin
// shows cut in half for good. So these pins: draw with plain views (no icon
// font), give every layer an explicit size, let the map rotate the marker
// (`rotation` + `flat`) instead of re-rendering the view, and keep
// tracksViewChanges on only for a moment after mount so the final frame is
// the one that sticks.

import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Marker } from "react-native-maps";
import { C } from "@/theme";

type LatLng = { latitude: number; longitude: number };

// Re-snapshot for the first moments only; after that the bitmap is static.
function useSettledSnapshot(key: unknown): boolean {
  const [tracking, setTracking] = useState(true);
  useEffect(() => {
    setTracking(true);
    const t = setTimeout(() => setTracking(false), 1200);
    return () => clearTimeout(t);
  }, [key]);
  return tracking;
}

const PUCK = 56;

export function DriverMarker({ coordinate, heading }: { coordinate: LatLng; heading?: number | null }) {
  const hasHeading = heading != null && heading >= 0;
  const tracking = useSettledSnapshot(hasHeading);
  return (
    <Marker
      coordinate={coordinate}
      anchor={{ x: 0.5, y: 0.5 }}
      flat
      rotation={hasHeading ? heading! : 0}
      tracksViewChanges={tracking}
      zIndex={10}
      title="You"
    >
      <View style={styles.puckBox} collapsable={false}>
        <View style={styles.halo} />
        <View style={styles.puck}>
          {hasHeading ? <View style={styles.arrow} /> : <View style={styles.dot} />}
        </View>
      </View>
    </Marker>
  );
}

export function DropMarker({ coordinate, label, title }: { coordinate: LatLng; label: string; title?: string }) {
  const tracking = useSettledSnapshot(label);
  return (
    <Marker coordinate={coordinate} anchor={{ x: 0.5, y: 1 }} zIndex={5} title={title} tracksViewChanges={tracking}>
      <View style={styles.dropBox} collapsable={false}>
        <View style={styles.drop}>
          <Text style={styles.dropText}>{label}</Text>
        </View>
        <View style={styles.dropTail} />
      </View>
    </Marker>
  );
}

const styles = StyleSheet.create({
  puckBox: { width: PUCK, height: PUCK, alignItems: "center", justifyContent: "center" },
  halo: {
    position: "absolute",
    width: PUCK,
    height: PUCK,
    borderRadius: PUCK / 2,
    backgroundColor: "rgba(30,214,127,0.2)",
  },
  puck: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: C.go,
    borderWidth: 3,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  // An upward-pointing triangle; the marker's `rotation` turns it to the heading.
  arrow: {
    width: 0,
    height: 0,
    marginTop: -3,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderBottomWidth: 11,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: C.onAccent,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.onAccent },
  dropBox: { width: 48, height: 50, alignItems: "center" },
  drop: {
    minWidth: 36,
    height: 36,
    paddingHorizontal: 8,
    borderRadius: 11,
    backgroundColor: C.text,
    borderWidth: 3,
    borderColor: C.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  dropText: { color: C.bg, fontWeight: "900", fontSize: 14 },
  dropTail: {
    width: 0,
    height: 0,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderTopWidth: 8,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderTopColor: C.text,
    marginTop: -2,
  },
});
