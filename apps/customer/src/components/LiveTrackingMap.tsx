import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import { type LatLng, bearing, milesBetween } from "../live-tracking";
import { colors } from "../theme";

// The live map on the order tracker, Uber Eats style: the driver glides
// between GPS fixes toward the customer's door, with the shop where the food
// came from. Apple Maps on iOS (no key); Google Maps on Android.
//
// Imported lazily by OrderStatusScreen, so a build without the native maps
// module (anything before 1.2.0) never evaluates this file.

type Props = {
  driver: LatLng | null;
  destination: LatLng | null;
  shop: LatLng | null;
  /** How much of the map the bottom sheet covers, so markers stay visible. */
  bottomInset: number;
  arrived: boolean;
};

const GLIDE_MS = 2500;

/** Moves the driver smoothly from the last fix to the new one instead of
 *  jumping every poll. */
function useGlide(target: LatLng | null): LatLng | null {
  const [shown, setShown] = useState<LatLng | null>(target);
  const from = useRef<LatLng | null>(target);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!target) return;
    const start = from.current ?? target;
    if (start.lat === target.lat && start.lng === target.lng) {
      setShown(target);
      return;
    }
    const t0 = Date.now();
    const step = () => {
      const k = Math.min(1, (Date.now() - t0) / GLIDE_MS);
      const e = 1 - Math.pow(1 - k, 3); // ease-out
      const p = { lat: start.lat + (target.lat - start.lat) * e, lng: start.lng + (target.lng - start.lng) * e };
      from.current = p;
      setShown(p);
      if (k < 1) frame.current = requestAnimationFrame(step);
    };
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [target?.lat, target?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  return shown;
}

function Pulse() {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(v, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.pulse,
        {
          opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
          transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.6] }) }],
        },
      ]}
    />
  );
}

const toCoord = (p: LatLng) => ({ latitude: p.lat, longitude: p.lng });

// Android: a quiet, desaturated base so the route and markers carry the eye.
const ANDROID_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#f3f4f6" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#6b7280" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#f9fafb" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#e5e7eb" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#dbeafe" }] },
];

export function LiveTrackingMap({ driver, destination, shop, bottomInset, arrived }: Props) {
  const map = useRef<MapView>(null);
  const shown = useGlide(driver);
  const [followed, setFollowed] = useState(true);
  const lastFix = useRef<LatLng | null>(null);
  const [heading, setHeading] = useState(0);

  // Point the driver arrow the way they're travelling.
  useEffect(() => {
    if (!driver) return;
    const prev = lastFix.current;
    if (prev && (prev.lat !== driver.lat || prev.lng !== driver.lng)) setHeading(bearing(prev, driver));
    else if (!prev && destination) setHeading(bearing(driver, destination));
    lastFix.current = driver;
  }, [driver?.lat, driver?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  const points = useMemo(
    () => [driver, destination, driver ? null : shop].filter(Boolean) as LatLng[],
    [driver, destination, shop],
  );

  const fit = (animated = true) => {
    if (!map.current || !points.length) return;
    // One point, or the driver practically at the door: fitting two nearly
    // identical points zooms in to a field of green, so hold street level.
    const close = points.length > 1 && milesBetween(points[0]!, points[1]!) < 0.08;
    if (points.length === 1 || close) {
      map.current.animateCamera({ center: toCoord(points[0]!), zoom: 16.5 }, { duration: animated ? 600 : 0 });
      return;
    }
    map.current.fitToCoordinates(points.map(toCoord), {
      edgePadding: { top: 90, right: 70, bottom: bottomInset + 40, left: 70 },
      animated,
    });
  };

  // Keep everyone in frame as the driver moves, unless the customer has
  // dragged the map to look around (then the Re-centre button brings it back).
  useEffect(() => {
    if (followed) fit(true);
  }, [driver?.lat, driver?.lng, destination?.lat, destination?.lng, followed, bottomInset]); // eslint-disable-line react-hooks/exhaustive-deps

  const initial = points[0] ?? { lat: 54.97, lng: -1.61 };

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView
        ref={map}
        style={StyleSheet.absoluteFill}
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : undefined}
        mapType={Platform.OS === "ios" ? "mutedStandard" : "standard"}
        customMapStyle={Platform.OS === "android" ? ANDROID_STYLE : undefined}
        initialRegion={{ latitude: initial.lat, longitude: initial.lng, latitudeDelta: 0.03, longitudeDelta: 0.03 }}
        onMapReady={() => fit(false)}
        onPanDrag={() => setFollowed(false)}
        showsCompass={false}
        showsPointsOfInterest={false}
        showsBuildings
        toolbarEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
      >
        {shop && !shown ? (
          <Marker coordinate={toCoord(shop)} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
            <View style={styles.shopPin}>
              <Ionicons name="restaurant" size={16} color={colors.primary} />
            </View>
          </Marker>
        ) : null}

        {shown && destination ? (
          <Polyline
            coordinates={[toCoord(shown), toCoord(destination)]}
            strokeColor={colors.primary}
            strokeWidth={4}
            lineDashPattern={[10, 8]}
            lineCap="round"
          />
        ) : null}

        {destination ? (
          <Marker coordinate={toCoord(destination)} anchor={{ x: 0.5, y: 1 }} tracksViewChanges={false}>
            <View style={styles.homeWrap}>
              <View style={styles.homePin}>
                <Ionicons name="home" size={16} color="#fff" />
              </View>
              <View style={styles.homeTail} />
            </View>
          </Marker>
        ) : null}

        {shown ? (
          <Marker
            coordinate={toCoord(shown)}
            anchor={{ x: 0.5, y: 0.5 }}
            // iOS animates the halo natively; Android snapshots marker views,
            // so it gets a still ring and is redrawn only when it turns.
            tracksViewChanges={Platform.OS === "ios"}
            zIndex={10}
          >
            <View style={styles.driverWrap}>
              {Platform.OS === "ios" && !arrived ? <Pulse /> : <View style={styles.ring} />}
              <View style={[styles.driverDot, arrived && { backgroundColor: colors.success }]}>
                <Ionicons
                  name={arrived ? "checkmark" : "navigate"}
                  size={20}
                  color="#fff"
                  style={arrived ? undefined : { transform: [{ rotate: `${heading - 45}deg` }] }}
                />
              </View>
            </View>
          </Marker>
        ) : null}
      </MapView>

      {!followed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Re-centre the map"
          onPress={() => setFollowed(true)}
          style={[styles.recentre, { bottom: bottomInset + 16 }]}
        >
          <Ionicons name="locate" size={18} color={colors.text} />
          <Text style={styles.recentreText}>Re-centre</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  driverWrap: { width: 84, height: 84, alignItems: "center", justifyContent: "center" },
  pulse: {
    position: "absolute",
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.primary,
  },
  ring: {
    position: "absolute",
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.primary,
    opacity: 0.18,
  },
  driverDot: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primary,
    borderWidth: 3,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  homeWrap: { alignItems: "center" },
  homePin: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: "#111827",
    borderWidth: 2,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    elevation: 5,
  },
  homeTail: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderTopWidth: 8,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderTopColor: "#111827",
    marginTop: -1,
  },
  shopPin: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#fff",
    borderWidth: 2,
    borderColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
  },
  recentre: {
    position: "absolute",
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  recentreText: { fontSize: 14, fontWeight: "700", color: colors.text },
});
