// Deciding whether an Android notification is a LIVE INCOMING CALL.
//
// This is the whole safety property of the VoIP path. A false positive pops a
// caller-ID card at the till for someone who is not on the phone — which is
// what happened: WhatsApp messages were being read as calls.
//
// The honest constraint: react-native-android-notification-listener does not
// expose Notification.category, so CATEGORY_CALL — the one authoritative
// signal Android has — is unavailable to us. Everything below is inference
// from text, and is written to fail CLOSED. A missed ring is a nuisance; a
// phantom ring interrupts service and shows staff the wrong customer.
//
// Kept dependency-free and pure so it can be reasoned about and exercised
// without an emulator.

export interface RawNotification {
  app?: string | null;
  title?: string | null;
  titleBig?: string | null;
  text?: string | null;
  subText?: string | null;
  summaryText?: string | null;
  bigText?: string | null;
  groupedMessages?: unknown[] | null;
  /** Post time in ms, as the library sends it (a string). */
  time?: string | number | null;
}

export type CallVerdict =
  | { ring: true; phoneSource: string }
  | { ring: false; reason: string };

/**
 * How stale a notification may be and still count as a ring.
 *
 * Android REPLAYS existing notifications to a listener whenever the service
 * reconnects — app restart, reboot, or the OS restarting the service. Without
 * this, every reconnect re-fired every call notification still on the shade,
 * ringing the till for calls that ended hours ago.
 */
export const MAX_AGE_MS = 60_000;

/**
 * Phrases that mean a call is happening RIGHT NOW.
 *
 * Anchored at the start of the field on purpose. A VoIP dialer's incoming-call
 * notification says exactly "Incoming call" or "Incoming voice call"; it does
 * not bury that in a sentence. A chat message that happens to contain the word
 * "calling" is a sentence, and must not match.
 */
const CALL_AT_START =
  /^\s*(incoming(\s+(voice|video))?\s+call|incoming\s+(voice|video)|call\s+from|ringing|calling\b)/i;

/**
 * "X is calling you" — real phrasing for some dialers, but also a sentence
 * shape a human could type. Only accepted in a SHORT field, because a
 * notification whose entire text is "Dave is calling" is a call and a message
 * that merely contains those words is not.
 */
const IS_CALLING = /\b(is calling( you)?|wants to talk)\b/i;
const SHORT_FIELD = 40;

/**
 * Markers that a notification is about a call that is NOT live, or is not a
 * call at all. Checked across every field, and checked FIRST.
 */
const NOT_A_LIVE_CALL =
  /(missed|declined|rejected|call ended|ended|call back|call again|voicemail|voice mail|ongoing|in progress|answered|connected|call duration|new message|message from|sent you|texted|voice message|typing|photo|video message|sticker|gif|audio message|shared|forwarded|you:|deleted)/i;

/** Notification shapes that only ever belong to a conversation. */
const MESSAGE_COUNT = /\b\d+\s+(new\s+)?messages?\b/i;
const CHAT_COUNT = /\b\d+\s+chats?\b/i;

function s(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Is this notification a live incoming call?
 *
 * Returns the field the caller should read the phone number from, so the
 * number is taken from the call notification's own title rather than scraped
 * out of whatever text happened to be attached — a message body containing a
 * phone number used to be enough to ring the till with that number.
 */
export function classifyNotification(
  notif: RawNotification,
  now: number = Date.now(),
): CallVerdict {
  const title = s(notif.title) || s(notif.titleBig);
  const text = s(notif.text);
  const big = s(notif.bigText);
  const sub = s(notif.subText);
  const summary = s(notif.summaryText);

  // A conversation, not a call. WhatsApp attaches the message history here.
  if (Array.isArray(notif.groupedMessages) && notif.groupedMessages.length > 0) {
    return { ring: false, reason: "grouped_messages" };
  }

  const everything = [title, text, big, sub, summary].filter(Boolean).join(" ");
  if (!everything) return { ring: false, reason: "empty" };

  if (MESSAGE_COUNT.test(everything) || CHAT_COUNT.test(everything)) {
    return { ring: false, reason: "message_summary" };
  }
  if (NOT_A_LIVE_CALL.test(everything)) {
    return { ring: false, reason: "not_live" };
  }

  // Stale replay — see MAX_AGE_MS.
  const posted = Number(notif.time);
  if (Number.isFinite(posted) && posted > 0) {
    const age = now - posted;
    if (age > MAX_AGE_MS) return { ring: false, reason: `stale_${Math.round(age / 1000)}s` };
  }

  // The call phrase must own the START of a field, not appear somewhere in a
  // sentence. `bigText` is deliberately excluded: it is where message bodies
  // live, and nothing that is only in bigText is a ringing phone.
  for (const [name, value] of [
    ["text", text],
    ["title", title],
  ] as const) {
    if (!value) continue;
    if (CALL_AT_START.test(value)) return { ring: true, phoneSource: name };
    if (value.length <= SHORT_FIELD && IS_CALLING.test(value)) {
      return { ring: true, phoneSource: name };
    }
  }

  return { ring: false, reason: "no_call_phrase" };
}

/**
 * The text to read the caller's number from, in preference order.
 *
 * Title first: every VoIP dialer puts the caller there, and it is the field
 * least likely to contain an unrelated number. bigText is never used.
 */
export function phoneCandidates(notif: RawNotification): string[] {
  return [s(notif.title), s(notif.titleBig), s(notif.text)].filter(Boolean);
}
