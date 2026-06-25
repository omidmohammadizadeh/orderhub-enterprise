// Push notifications for the driver app. When dispatch assigns a job, the
// server sends a push with category "new-job" — which renders **Accept** and
// **Reject** buttons directly on the notification, even when the app is closed.

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { registerPushToken, jobAction } from "./auth";

export const JOB_CATEGORY = "new-job";

// Foreground display: show the banner + play a sound so the driver notices.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

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
    await Notifications.setNotificationChannelAsync("jobs", {
      name: "New jobs",
      importance: Notifications.AndroidImportance.MAX,
      sound: "default",
      vibrationPattern: [0, 250, 250, 250],
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
 * Wire the notification action buttons to the API. ACCEPT (or tapping the
 * body) accepts the job; REJECT skips it. Returns an unsubscribe fn.
 */
export function attachJobResponseHandler(onAccepted?: (orderId: string) => void) {
  const sub = Notifications.addNotificationResponseReceivedListener(async (resp) => {
    const data = resp.notification.request.content.data as { orderId?: string };
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
    onAccepted?.(orderId);
  });
  return () => sub.remove();
}
