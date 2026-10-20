// Push notifications for the driver app. When dispatch assigns a job, the
// driver gets an alert with category "new-job" — **Accept** and **Reject**
// buttons on the notification itself. iOS draws them from the push; Android
// only draws them on an alert the app presents, which job-push-task.ts does
// from a data-only push (so they also show when the app is closed).

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as Notifications from "expo-notifications";
import * as Location from "expo-location";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { registerPushToken, jobAction } from "./auth";
import { JOB_CATEGORY, JOB_CHANNEL, claimResponse, parseJobResponse } from "./job-push";
import { registerJobPushTask } from "./job-push-task";

export { JOB_CATEGORY, JOB_CHANNEL };
// Chat messages (operator + customer) — heads-up with the default tone.
export const MESSAGES_CHANNEL = "messages";
// Bundled via app.json → expo-notifications.sounds — the same chime the
// dashboard plays for new orders.
const JOB_SOUND = "new_order.wav";

// Foreground display: show the banner + play a sound so the driver notices.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // SDK 54 (expo-notifications): shouldShowAlert split into
    // shouldShowBanner + shouldShowList.
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Clear the launcher icon badge + dismiss delivered notifications from the tray.
// Call when the app opens / returns to the foreground.
export async function clearNotificationBadges() {
  try {
    await Notifications.setBadgeCountAsync(0);
  } catch {
    // ignore
  }
  try {
    await Notifications.dismissAllNotificationsAsync();
  } catch {
    // ignore
  }
}

export async function setupJobCategory() {
  await Notifications.setNotificationCategoryAsync(JOB_CATEGORY, [
    { identifier: "ACCEPT", buttonTitle: "Accept", options: { opensAppToForeground: true } },
    {
      identifier: "REJECT",
      buttonTitle: "Reject",
      options: { isDestructive: true, opensAppToForeground: false },
    },
  ]);
}

/**
 * Are notifications actually allowed on this device?
 *
 * iOS asks once. A driver who taps "Don't Allow" is never asked again, no
 * token is ever registered, and dispatch's push goes nowhere — with nothing on
 * the phone or in the app to say so. From the shop's side the job simply never
 * arrives, on that one driver's phone, for ever.
 */
export async function pushPermissionGranted(): Promise<boolean> {
  try {
    return (await Notifications.getPermissionsAsync()).status === "granted";
  } catch {
    // Don't cry wolf on an unknown state — the banner is only worth showing
    // when we are sure it is off.
    return true;
  }
}

/**
 * "Allow all permissions" — everything the app needs, in one tap.
 *
 * The hard part is that iOS only ever shows a permission dialog ONCE. After a
 * driver taps "Don't Allow", requestPermissionsAsync returns denied instantly
 * with no dialog at all, so a button that only re-requests would look broken:
 * tap, nothing happens, still no job alerts.
 *
 * So this asks for whatever has never been asked, and reports back what is
 * still blocked. Only the Settings app can undo a denial, and the caller sends
 * them there.
 */
export async function requestAllPermissions(): Promise<{
  notifications: boolean;
  location: boolean;
  /** True when something is denied and only Settings can fix it. */
  needsSettings: boolean;
}> {
  let notifications = false;
  try {
    const current = await Notifications.getPermissionsAsync();
    notifications = current.status === "granted";
    // canAskAgain is false once the one dialog has been used up.
    if (!notifications && current.canAskAgain !== false) {
      notifications =
        (await Notifications.requestPermissionsAsync()).status === "granted";
    }
  } catch {
    notifications = false;
  }

  // Registering the token is the point of the notification permission — do it
  // here so a driver who has just granted it starts receiving jobs without
  // signing out and back in.
  if (notifications) {
    try {
      await registerForPush();
    } catch {
      // not fatal — retried on next launch
    }
  }

  let location = false;
  try {
    // Foreground only. BACKGROUND location is deliberately not requested here:
    // Google Play requires a prominent disclosure before that ask, which this
    // app shows on the online toggle (LocationDisclosure). Requesting it from
    // a menu button would skip that screen and put the build at risk of
    // rejection. Going online still asks for it, with the disclosure first.
    const fg = await Location.requestForegroundPermissionsAsync();
    location = fg.status === "granted";
  } catch {
    location = false;
  }

  return {
    notifications,
    location,
    needsSettings: !notifications || !location,
  };
}

export async function registerForPush(): Promise<string | null> {
  let status = (await Notifications.getPermissionsAsync()).status;
  if (status !== "granted") {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== "granted") return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(JOB_CHANNEL, {
      name: "New delivery jobs",
      importance: Notifications.AndroidImportance.MAX, // heads-up pop-up
      sound: JOB_SOUND, // custom new-order chime (res/raw)
      vibrationPattern: [0, 250, 250, 250],
      enableVibrate: true,
      bypassDnd: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
    await Notifications.setNotificationChannelAsync(MESSAGES_CHANNEL, {
      name: "Chat messages",
      importance: Notifications.AndroidImportance.HIGH, // heads-up pop-up
      sound: "default",
      vibrationPattern: [0, 200, 150, 200],
      enableVibrate: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }

  try {
    const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId;
    const tokenResp = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    const token = tokenResp.data;
    // Ask for data-only job pushes only once the task that presents them is
    // registered — otherwise the job alert would arrive with nothing to show it.
    const presentsJobsItself = await registerJobPushTask();
    try {
      await registerPushToken(token, presentsJobsItself ? "data" : undefined);
    } catch {
      // not fatal — driver can still use the app; retried on next launch
    }
    return token;
  } catch {
    return null;
  }
}

/**
 * Wire notification taps to the app. For a new-job alert: ACCEPT (or tapping the
 * body) accepts, REJECT skips. For a chat alert (data.type === "chat"): open the
 * relevant conversation instead. Returns an unsubscribe fn.
 *
 * Also picks up the tap that cold-launched the app (ACCEPT on an alert while
 * the app was closed): that response fired before this listener existed.
 */
export function attachJobResponseHandler(handlers: {
  onJobAccepted?: (orderId: string) => void;
  onOpenChat?: (info: { channel?: string; orderId?: string }) => void;
}) {
  const handle = async (resp: Notifications.NotificationResponse) => {
    const parsed = parseJobResponse(resp);
    if (!parsed || !claimResponse(parsed.key)) return;
    const data = parsed.data as { type?: string; channel?: string };
    // Chat notification — never run a job action; just open the conversation.
    if (data.type === "chat") {
      handlers.onOpenChat?.({ channel: data.channel, orderId: parsed.orderId ?? undefined });
      return;
    }
    const orderId = parsed.orderId;
    if (!orderId) return;
    if (parsed.actionIdentifier === "REJECT") {
      try {
        await jobAction(orderId, "skip");
      } catch {
        // ignore
      }
      return;
    }
    try {
      await jobAction(orderId, "accept");
    } catch {
      // ignore
    }
    handlers.onJobAccepted?.(orderId);
  };

  const sub = Notifications.addNotificationResponseReceivedListener(handle);
  const launch = Notifications.getLastNotificationResponse();
  // Only a fresh tap: the last response outlives the alert, and accepting an
  // hour-old run on the next launch would be a surprise.
  if (launch && Date.now() - epochMs(launch.notification.date) < LAUNCH_RESPONSE_MAX_AGE_MS) {
    handle(launch).finally(() => Notifications.clearLastNotificationResponse());
  }
  return () => sub.remove();
}

const LAUNCH_RESPONSE_MAX_AGE_MS = 10 * 60_000;

// iOS reports a notification's date in seconds, Android in milliseconds.
function epochMs(date: number): number {
  return date < 1e12 ? date * 1000 : date;
}
