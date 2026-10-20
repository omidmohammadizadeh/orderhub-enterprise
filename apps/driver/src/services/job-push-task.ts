// New-job alerts with Accept/Reject buttons on Android, even when the app is
// backgrounded or closed.
//
// Android draws a category's buttons only on a notification the APP presents.
// An ordinary alert push (title + body) is drawn by the system whenever the app
// isn't in the foreground, and the system knows nothing about categories — so
// the driver got a bare "New delivery run" with no buttons. Instead, an install
// that registers this task tells the API (push-token `format: "data"`) to send
// the job as a data-only push; this task wakes for it and presents the alert
// itself, with the "new-job" category.
//
// The task also runs for a button tap while the app is backgrounded or closed
// (Android only), which is how REJECT works without opening the app.
//
// Defined at module scope and imported from App.tsx: expo-task-manager boots
// the JS bundle headlessly to run it when the app is closed.

import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { jobAction } from "./auth";
import { JOB_CATEGORY, JOB_CHANNEL, claimResponse, parseJobPush, parseJobResponse } from "./job-push";

export const JOB_PUSH_TASK = "orderhub-driver-job-push";
// Bundled via app.json → expo-notifications.sounds. On Android 8+ the channel's
// sound is what plays; this covers the rest.
const JOB_SOUND = "new_order.wav";

TaskManager.defineTask<Notifications.NotificationTaskPayload>(JOB_PUSH_TASK, async ({ data, error }) => {
  if (error || !data) return;

  if ("actionIdentifier" in data) {
    await handleBackgroundResponse(data);
    return;
  }

  const job = parseJobPush(data);
  if (!job) return;
  try {
    await Notifications.scheduleNotificationAsync({
      // One alert per order: a re-sent push replaces it rather than stacking.
      identifier: `job-${job.orderId}`,
      content: {
        title: job.title,
        body: job.body,
        data: { orderId: job.orderId },
        categoryIdentifier: JOB_CATEGORY,
        sound: JOB_SOUND,
        priority: Notifications.AndroidNotificationPriority.MAX,
      },
      trigger: { channelId: JOB_CHANNEL },
    });
  } catch {
    // Nothing else to fall back to from here; the job is still on the driver's
    // screen the next time the app polls.
  }
});

async function handleBackgroundResponse(payload: unknown) {
  const response = parseJobResponse(payload);
  // ACCEPT (and a tap on the body) opens the app, where the response listener
  // accepts with a foreground session. Only REJECT is handled here.
  if (!response?.orderId || response.actionIdentifier !== "REJECT") return;
  if (!claimResponse(response.key)) return;
  try {
    await jobAction(response.orderId, "skip");
    await Notifications.dismissNotificationAsync(`job-${response.orderId}`).catch(() => {});
  } catch {
    // With the app closed there is no foreground session to refresh an expired
    // access token (refresh tokens are single-use; only the foreground rotates
    // them — see auth.ts). Say so rather than leave the driver thinking it
    // went through. No orderId in the data, so tapping this never accepts.
    await Notifications.scheduleNotificationAsync({
      identifier: `job-${response.orderId}`,
      content: {
        title: "Reject didn't go through",
        body: "Open Order Hub Driver to reject the run.",
        data: { type: "reject-failed" },
      },
      // The chat channel: a heads-up with the normal tone, not the job chime.
      trigger: { channelId: "messages" },
    }).catch(() => {});
  }
}

let registered: Promise<boolean> | null = null;

/**
 * Register the task once. Resolves true only when it is registered — the
 * caller then asks the API for data-only job pushes. Never claim that on iOS
 * (APNs alerts already show the buttons) or if registration failed: a
 * data-only push with nothing to present it would be a silently lost job.
 */
export function registerJobPushTask(): Promise<boolean> {
  if (Platform.OS !== "android") return Promise.resolve(false);
  registered ??= Notifications.registerTaskAsync(JOB_PUSH_TASK)
    .then(() => true)
    .catch(() => {
      registered = null;
      return false;
    });
  return registered;
}
