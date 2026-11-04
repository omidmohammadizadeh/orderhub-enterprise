// Order-update notifications. The phone's Expo push token is registered to
// the customer's account (POST efl/me/push) while signed in, and removed on
// sign-out. An Eat For Less order update arrives with
// data { orderId, status, app: "eatforless" }; tapping it opens tracking.

import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { registerPush, unregisterPush } from "@/api/efl";
import { navigationRef } from "@/navigation/ref";

const TOKEN_KEY = "efl.pushToken";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Expo push tokens are minted per EAS project. Until `eas init` has run for
 *  Eat For Less there is no project id, and registration is skipped. */
function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? null;
}

/**
 * Ask (once) and register. `ask` is false on launch — we only re-register a
 * permission already given — and true right after sign-in, when the customer
 * knows why we'd message them.
 */
export async function registerForOrderUpdates(opts: { ask: boolean; marketingOptIn?: boolean }): Promise<void> {
  try {
    let { status, canAskAgain } = await Notifications.getPermissionsAsync();
    if (status !== "granted" && opts.ask && canAskAgain) {
      ({ status } = await Notifications.requestPermissionsAsync());
    }
    if (status !== "granted") return;
    const id = projectId();
    if (!id) {
      if (__DEV__) console.info("[push] no EAS project id yet; skipping token registration");
      return;
    }
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    await registerPush({ token, platform: Platform.OS === "ios" ? "ios" : "android", marketingOptIn: opts.marketingOptIn });
    await AsyncStorage.setItem(TOKEN_KEY, token);
  } catch (err) {
    if (__DEV__) console.info("[push] registration skipped:", (err as Error).message);
  }
}

/** Must run while the session token is still valid. */
export async function unregisterOrderUpdates(): Promise<void> {
  const token = await AsyncStorage.getItem(TOKEN_KEY).catch(() => null);
  if (!token) return;
  await unregisterPush(token).catch(() => {});
  await AsyncStorage.removeItem(TOKEN_KEY).catch(() => {});
}

function openFrom(response: Notifications.NotificationResponse | null) {
  const data = response?.notification.request.content.data as { orderId?: string; app?: string } | undefined;
  if (data?.app !== "eatforless" || !data.orderId) return;
  const go = () => navigationRef.navigate("Tracking", { orderId: data.orderId! });
  if (navigationRef.isReady()) go();
  else setTimeout(go, 800);
}

/** Taps on order updates, including the one that launched the app. */
export function listenForOrderTaps(): () => void {
  void Notifications.getLastNotificationResponseAsync().then(openFrom);
  const sub = Notifications.addNotificationResponseReceivedListener(openFrom);
  return () => sub.remove();
}
