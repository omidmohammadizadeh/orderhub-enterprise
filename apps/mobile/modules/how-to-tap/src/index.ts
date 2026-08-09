import { requireNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

// Apple's ProximityReaderDiscovery "How to Tap" overlay — required by Apple
// before submitting a Tap to Pay app for review. iOS 18.0+ only; on Android
// or older iOS this module isn't linked at all, so every export here is a
// safe no-op there (see the Platform.OS guards below).
interface HowToTapNativeModule {
  isAvailable(): Promise<boolean>;
  /** Resolves `true` if the overlay was actually shown (iOS 18+), `false`
   *  if this OS doesn't support it — the caller should show its own
   *  fallback education screen in that case. */
  show(): Promise<boolean>;
}

const native: HowToTapNativeModule | null =
  Platform.OS === "ios" ? requireNativeModule<HowToTapNativeModule>("HowToTap") : null;

export async function isHowToTapAvailable(): Promise<boolean> {
  if (!native) return false;
  try {
    return await native.isAvailable();
  } catch {
    return false;
  }
}

/** Returns true if Apple's native overlay was shown; false means the
 *  caller must show its own fallback merchant-education screen instead. */
export async function showHowToTap(): Promise<boolean> {
  if (!native) return false;
  try {
    return await native.show();
  } catch {
    return false;
  }
}
