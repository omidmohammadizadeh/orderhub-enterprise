// Pure helpers for the new-job push — no React Native imports, so the payload
// handling can be unit-tested in node (see job-push.spec.ts).

export const JOB_CATEGORY = "new-job";
// Android caches a channel's sound/importance at creation — changing them
// requires a NEW channel id. Bump this whenever the channel config changes.
export const JOB_CHANNEL = "jobs-v2";

export interface JobPush {
  orderId: string;
  title: string;
  body: string;
}

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === "object" && v !== null;
}

function parseJson(raw: unknown): Dict | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isDict(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The job inside a data-only push, as the background task receives it.
 *
 * The API sends `{ type: "new-job", orderId, title, body }` with no title/body
 * of its own (expo-push.service.ts). Expo hands that to FCM as a JSON string,
 * which arrives here as `data.dataString` (`data.body` on older clients).
 */
export function parseJobPush(payload: unknown): JobPush | null {
  if (!isDict(payload) || !isDict(payload.data)) return null;
  const data = parseJson(payload.data.dataString) ?? parseJson(payload.data.body);
  if (!data || data.type !== "new-job") return null;
  const { orderId, title, body } = data;
  if (typeof orderId !== "string" || !orderId) return null;
  return {
    orderId,
    title: typeof title === "string" && title ? title : "New delivery run",
    body: typeof body === "string" && body ? body : "Tap to open the run.",
  };
}

/** A notification response as the background task gets it (raw native bundle). */
export interface JobResponse {
  key: string;
  actionIdentifier: string;
  orderId: string | null;
  data: Dict;
}

/**
 * Read a notification response, from either the JS listener (content.data is an
 * object) or the Android background task (content.data may be a bundle, or the
 * JSON sits in content.dataString).
 */
export function parseJobResponse(payload: unknown): JobResponse | null {
  if (!isDict(payload) || typeof payload.actionIdentifier !== "string") return null;
  const notification = isDict(payload.notification) ? payload.notification : {};
  const request = isDict(notification.request) ? notification.request : {};
  const content = isDict(request.content) ? request.content : {};
  const data =
    (isDict(content.data) && Object.keys(content.data).length > 0 ? content.data : null) ??
    parseJson(content.dataString) ??
    {};
  const orderId = typeof data.orderId === "string" && data.orderId ? data.orderId : null;
  const id = typeof request.identifier === "string" ? request.identifier : "";
  return {
    key: `${id}|${payload.actionIdentifier}`,
    actionIdentifier: payload.actionIdentifier,
    orderId,
    data,
  };
}

// The same tap can reach us twice: on Android, with the app alive in the
// background, both the background task and the JS response listener get it,
// and a cold launch from a button can surface it again as the "last response".
// Accepting or skipping twice would be wrong, so the first to claim it wins.
const claimed = new Set<string>();

export function claimResponse(key: string): boolean {
  if (claimed.has(key)) return false;
  claimed.add(key);
  return true;
}
