// Push notifications for the driver app. When dispatch assigns a job, the
// server sends a push with category "new-job" — which renders **Accept** and
// **Reject** buttons directly on the notification, even when the app is closed.

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { registerPushToken, jobAction } from "./auth";

export const JOB_CATEGORY = "new-job";
// Android caches a channel's sound/importance at creation — changing them
// requires a NEW channel id. Bump this whenever the channel config changes.
export const JOB_CHANNEL = "jobs-v2";
// Chat messages (operator + customer) — heads-up with the default tone.
export const MESSAGES_CHANNEL = "messages";
// Bundled via app.json → expo-notifications.sounds — the same chime the
// dashboard plays for new orders.
const JOB_SOUND = "new_order.wav";

// Foreground display: show the banner + play a sound so the driver notices.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
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
    try {
      await registerPushToken(token);
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
 */
export function attachJobResponseHandler(handlers: {
  onJobAccepted?: (orderId: string) => void;
  onOpenChat?: (info: { channel?: string; orderId?: string }) => void;
}) {
  const sub = Notifications.addNotificationResponseReceivedListener(async (resp) => {
    const data = resp.notification.request.content.data as {
      type?: string;
      orderId?: string;
      channel?: string;
    };
    // Chat notification — never run a job action; just open the conversation.
    if (data?.type === "chat") {
      handlers.onOpenChat?.({ channel: data.channel, orderId: data.orderId });
      return;
    }
    const orderId = data?.orderId;
    if (!orderId) return;
    if (resp.actionIdentifier === "REJECT") {
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
  });
  return () => sub.remove();
}
