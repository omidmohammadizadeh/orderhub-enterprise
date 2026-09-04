// The parts of a call that must never vary, and must never cost a model call.
//
// The conversation itself belongs to Claude — it is genuinely better than a
// decision tree at "actually make that a large, and no onions". But the SPINE
// of the call does not belong to Claude, because a caller who hears a slightly
// different menu every time does not trust the line, and a model that decides
// on turn one whether this is an order or a complaint gets it wrong often
// enough to matter.
//
// So: this file is a state machine with no I/O and no model. It is what the
// caller hears before the brain is involved, and it is the only place the
// press-1/press-2 menu is defined.
//
// The rule running through all of it: NEVER TRAP THE CALLER. Every unclear
// input falls forward into taking an order, never into "sorry, I didn't get
// that, please press 1 or 2" — which is the single thing people hate most
// about phone menus, and the reason most of them get abandoned.

/** Where a call is. Stored on the transcript blob, so it survives the fact
 *  that every webhook is a separate HTTP request to a stateless service. */
export type VoiceStage =
  /** Greeting played; waiting for a menu choice (pressed or spoken). */
  | "MENU"
  /** In the ordering conversation. Claude drives from here. */
  | "ORDER"
  /** Asked for an order number, waiting to hear one. */
  | "STATUS"
  /** Said goodbye. */
  | "DONE";

export type MenuChoice =
  /** Take an order. `passThrough` is set when the caller skipped the menu and
   *  went straight into ordering — that text is their first real turn, and
   *  throwing it away to ask "collection or delivery?" makes us look deaf. */
  | { kind: "ORDER"; passThrough?: string }
  | { kind: "STATUS" }
  | { kind: "HUMAN" };

/** A caller who wants a person gets one, at any point, however they ask. */
const HUMAN = [
  "speak to a person",
  "speak to someone",
  "talk to someone",
  "talk to a person",
  "real person",
  "a human",
  "human being",
  "member of staff",
  "the manager",
  "customer service",
];

/** Phrases that only ever mean "I already have an order". Deliberately
 *  phrases, not single words: "order" on its own is what someone says when
 *  they want to PLACE one, and routing those to the status branch would be
 *  the worst possible first impression. */
const STATUS_INTENT = [
  "where is my",
  "where's my",
  "wheres my",
  "update on my",
  "an update on",
  "track my",
  "how long will my",
  "how long is my",
  "already ordered",
  "already placed",
  "placed an order",
  "ordered earlier",
  "my order number",
  "check my order",
  "check on my order",
  "chase my",
  "still waiting",
  "hasn't arrived",
  "hasnt arrived",
  "not arrived",
  "not turned up",
];

/** "one", "number one", "press one", "option 1 please", "1" — a bare selection
 *  and nothing but. Anything longer is treated as speech, not a keypress.
 *
 *  The trailing courtesy is not optional in practice: almost nobody says just
 *  "two", they say "number two please", and dropping those on the floor sent
 *  them into the ordering conversation instead of the option they had picked.
 */
const POLITE = "(?:\\s+(?:please|pls|thanks|thank\\s+you|mate|love|cheers))?";
const LEAD = "(?:(?:i'?ll\\s+)?(?:press|option|number|press\\s+number|take)\\s*)?";
const bare = (digits: string) =>
  new RegExp(`^${LEAD}(?:${digits})\\b${POLITE}[.!]?$`, "i");

const BARE_ONE = bare("1|one|won");
const BARE_TWO = bare("2|two|too|to");
const BARE_ZERO = bare("0|zero|nought");

const clean = (text: string): string =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * A pressed key. Unambiguous, instant, and the reason the menu exists at all —
 * a caller on a bad line, or one who simply doesn't want to talk to a robot,
 * can always get through with a keypress.
 */
export function digitChoice(digit: string): MenuChoice | null {
  switch (String(digit ?? "").trim()) {
    case "1":
      return { kind: "ORDER" };
    case "2":
      return { kind: "STATUS" };
    // 0 is the near-universal "get me a person" key. Nobody has to be told.
    case "0":
      return { kind: "HUMAN" };
    default:
      return null;
  }
}

/**
 * What the caller SAID at the menu.
 *
 * This is the half of the menu the caller was never told about, and it is what
 * makes the line feel like a person rather than a phone tree: "yeah can I get
 * two large pepperoni" during the greeting goes straight into that order, menu
 * never mentioned again.
 */
export function interpretMenuChoice(text: string): MenuChoice {
  const t = clean(text);
  if (!t) return { kind: "ORDER" };

  if (HUMAN.some((p) => t.includes(p))) return { kind: "HUMAN" };
  if (BARE_ZERO.test(t)) return { kind: "HUMAN" };

  // A short bare utterance is a spoken keypress. Checked before intent so
  // "two" is the menu choice, while "two large pepperoni" is an order — the
  // distinction is length, because nobody says just "two" to order two of
  // something they haven't named yet.
  const words = t.split(" ").filter(Boolean);
  if (words.length <= 4) {
    if (BARE_ONE.test(t)) return { kind: "ORDER" };
    if (BARE_TWO.test(t)) return { kind: "STATUS" };
  }

  if (STATUS_INTENT.some((p) => t.includes(p))) return { kind: "STATUS" };

  // Everything else is an order, and the caller's words carry forward. This
  // default is the whole point: an unrecognised sentence must never cost the
  // caller a repeat of the menu.
  return { kind: "ORDER", passThrough: String(text).trim() };
}

const WORD_DIGITS: Record<string, string> = {
  zero: "0",
  oh: "0",
  o: "0",
  nought: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

/**
 * Pull an order number out of what the caller said: "it's four oh one two",
 * "4012", "order number 4012" all give "4012".
 *
 * Homophones ("for" → four, "to" → two) are deliberately NOT mapped. They are
 * common in phone transcription, but a mis-parsed digit here reads a DIFFERENT
 * customer's order back down the line, and asking someone to repeat a number
 * is a far smaller cost than that.
 */
export function parseSpokenNumber(text: string): string | null {
  const out: string[] = [];
  for (const token of clean(text).split(" ")) {
    if (/^\d+$/.test(token)) out.push(token);
    else if (WORD_DIGITS[token]) out.push(WORD_DIGITS[token]);
  }
  const digits = out.join("");
  return digits.length ? digits : null;
}

/**
 * Read a number back one digit at a time. "4012" spoken as "four thousand and
 * twelve" is not something a caller can check against the text on their phone,
 * and the commas are what make the speech engine pause between them.
 */
export function spokenDigits(value: string | number): string {
  return String(value ?? "")
    .replace(/\D/g, "")
    .split("")
    .join(", ");
}

/**
 * An order's stage, in words a customer actually uses.
 *
 * Deliberately not the enum name. "PENDING_DISPATCH" means nothing to someone
 * standing in their kitchen, and every one of these lines has to end in a way
 * that doesn't invite a follow-up question we can't answer.
 */
export function spokenOrderStatus(args: {
  status: string;
  fulfillmentType?: string | null;
  minutesAway?: number | null;
}): { say: string; transfer?: boolean } {
  const delivery = args.fulfillmentType === "DELIVERY";
  const eta =
    args.minutesAway != null && args.minutesAway > 0
      ? ` It should be about ${args.minutesAway} minutes.`
      : "";

  switch (args.status) {
    case "PENDING":
      return { say: `The shop has it, but they haven't confirmed it yet.${eta}` };
    case "ACCEPTED":
      return { say: `That's confirmed, and the kitchen is about to start it.${eta}` };
    case "PREPARING":
      return { say: `That's being made now.${eta}` };
    case "READY":
      return {
        say: delivery
          ? "That's ready and waiting for a driver."
          : "That's ready for collection now.",
      };
    case "PENDING_DISPATCH":
    case "ASSIGNED_DRIVER":
    case "ACCEPTED_BY_DRIVER":
      return { say: "That's ready, and we're getting a driver to it now." };
    case "RIDER_ARRIVED":
      return { say: "The driver is at the shop picking it up right now." };
    case "OUT_FOR_DELIVERY":
    case "DISPATCHED":
      return { say: `That's on its way to you now.${eta}` };
    case "COMPLETED":
      return {
        say: delivery
          ? "That one's down as delivered."
          : "That one's down as collected.",
      };
    case "CANCELLED":
    case "REJECTED":
    case "FAILED":
      // Never try to explain a cancellation. Whatever happened, the caller
      // needs a person, and they need one immediately.
      return {
        say: "It looks like there's a problem with that order. Let me put you through to the shop.",
        transfer: true,
      };
    default:
      return {
        say: "I can see the order, but I can't tell what stage it's at. Let me put you through to the shop.",
        transfer: true,
      };
  }
}
