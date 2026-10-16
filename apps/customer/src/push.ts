import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { registerDevice, setMarketingPreference, subscribeToOrder } from "./api";
import { appId, brand, easProjectId, withBrandQuery } from "./brand";

const TOKEN_KEY = "push:token";
const OFFERS_KEY = "push:offers"; // "1" | "0"; missing = not asked yet

const platform = Platform.OS === "ios" ? "ios" : "android";

// Show order updates as a banner even while the app is open: the customer
// may be looking at the menu when their food is ready.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let tokenPromise: Promise<string | null> | null = null;

async function fetchToken(): Promise<string | null> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Order updates",
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: brand.primaryColor,
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") {
    ({ status } = await Notifications.requestPermissionsAsync());
  }
  if (status !== "granted") return null;
  if (!easProjectId) {
    console.warn("[push] no easProjectId in this brand's config — run: npm run brand -- init <slug>");
    return null;
  }
  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId: easProjectId });
    await AsyncStorage.setItem(TOKEN_KEY, data);
    return data;
  } catch (err) {
    // Simulators on Intel Macs and Android emulators without Play services
    // can't get a token. The app works without one; it just can't buzz.
    console.warn(`[push] no push token (${Device.isDevice ? "device" : "simulator"}):`, String(err));
    return null;
  }
}

/** Caches the token for the session once there is one. A miss isn't cached,
 *  so allowing notifications in Settings later works without a restart. */
export function getPushToken(): Promise<string | null> {
  if (!tokenPromise) {
    tokenPromise = fetchToken().then((t) => {
      if (!t) tokenPromise = null;
      return t;
    });
  }
  return tokenPromise;
}

export async function getOffersPreference(): Promise<boolean | null> {
  const v = await AsyncStorage.getItem(OFFERS_KEY);
  return v === null ? null : v === "1";
}

/** On every launch: register this install under the brand, carrying the
 *  current offers choice (the server treats the app as the source of truth). */
export async function registerOnLaunch(): Promise<string | null> {
  const token = await getPushToken();
  if (!token) return null;
  const offers = (await getOffersPreference()) === true;
  try {
    await registerDevice({ expoToken: token, platform, appId, marketingOptIn: offers });
    console.log(`[push] registered ${token} for brand ${brand.brandId} (offers ${offers ? "on" : "off"})`);
  } catch (err) {
    console.warn("[push] register-device failed:", String(err));
  }
  return token;
}

/** Offers are off until the customer says yes — Apple 4.5.4 wants explicit
 *  consent for marketing pushes, separate from order updates. */
export async function setOffers(on: boolean): Promise<void> {
  await AsyncStorage.setItem(OFFERS_KEY, on ? "1" : "0");
  const token = await getPushToken();
  if (!token) return;
  try {
    await setMarketingPreference(token, on);
    console.log(`[push] offers ${on ? "on" : "off"} for ${token}`);
  } catch (err) {
    console.warn("[push] preferences failed:", String(err));
  }
}

export function trackPathFor(slug: string, orderId: string): string {
  return withBrandQuery(`/order/${slug}/status/${orderId}`);
}

// One page load reports its URL several times (navigation event, pushState,
// load), so remember what this session already followed. A failure may be
// retried, but not more than once every 30 s.
const followed = new Map<string, number | "ok">();
const RETRY_MS = 30_000;

/** Follow one order's progress on this phone. Safe to call repeatedly. */
export async function followOrder(orderId: string, slug: string): Promise<void> {
  const last = followed.get(orderId);
  if (last === "ok" || (typeof last === "number" && Date.now() - last < RETRY_MS)) return;
  followed.set(orderId, Date.now());
  const token = await getPushToken();
  if (!token) return;
  try {
    await subscribeToOrder({ orderId, expoToken: token, platform, appId, trackPath: trackPathFor(slug, orderId) });
    followed.set(orderId, "ok");
    console.log(`[push] following order ${orderId}`);
  } catch (err) {
    console.warn("[push] subscribe failed:", String(err));
  }
}
