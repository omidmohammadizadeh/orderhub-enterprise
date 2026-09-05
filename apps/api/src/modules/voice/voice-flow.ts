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

import { soundFold } from "./voice-menu-match";

/** Where a call is. Stored on the transcript blob, so it survives the fact
 *  that every webhook is a separate HTTP request to a stateless service. */
export type VoiceStage =
  /** Greeting played; waiting for a menu choice (pressed or spoken). */
  | "MENU"
  /** In the ordering conversation. Claude drives from here. */
  | "ORDER"
  /** Asked for an order number, waiting to hear one. */
  | "STATUS"
  /** Asked for an order number so they can CHANGE that order. */
  | "AMEND"
  /** Said goodbye. */
  | "DONE";

export type MenuChoice =
  /** Take an order. `passThrough` is set when the caller skipped the menu and
   *  went straight into ordering — that text is their first real turn, and
   *  throwing it away to ask "collection or delivery?" makes us look deaf. */
  | { kind: "ORDER"; passThrough?: string }
  | { kind: "STATUS" }
  /** Change an order they have already placed. */
  | { kind: "AMEND" }
  /** Something is wrong with an order. Always a person. */
  | { kind: "COMPLAINT" }
  /** Say the options again. */
  | { kind: "REPEAT" }
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
const BARE_THREE = bare("3|three|tree");
const BARE_FOUR = bare("4|four|for|fore");
const BARE_FIVE = bare("5|five");
const BARE_ZERO = bare("0|zero|nought");

/** Changing an order that already exists — not placing a new one. */
const AMEND_INTENT = [
  "add to my order",
  "add something to my order",
  "add to it",
  "change my order",
  "change an order",
  "amend my order",
  "amend an order",
  "update my order",
  "update an order",
  "add another",
  "forgot to add",
  "forgot something",
  "add one more",
];

/** Something is wrong. These always end with a person. */
const COMPLAINT_INTENT = [
  "complain",
  "complaint",
  "wrong order",
  "missing",
  "cold",
  "never arrived",
  "didn't arrive",
  "didnt arrive",
  "not happy",
  "unhappy",
  "refund",
  "money back",
  "disgusting",
  "terrible",
];

/** Say it all again. */
const REPEAT_INTENT = [
  "say that again",
  "repeat that",
  "repeat the options",
  "what are the options",
  "say the options",
  "hear the options",
  "what were they",
  "didn't catch the options",
];

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
    case "3":
      return { kind: "AMEND" };
    case "4":
      return { kind: "COMPLAINT" };
    case "5":
      return { kind: "REPEAT" };
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
/**
 * Is the caller asking for a person?
 *
 * Checked on EVERY turn, not just at the menu. "Asking for a human must always
 * work" is one of the four rules this module was written around, and it was
 * only actually true on the first turn — after that it depended on the model
 * noticing. That is not "always".
 */
export function wantsHuman(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  return HUMAN.some((p) => t.includes(p)) || BARE_ZERO.test(t);
}

export function interpretMenuChoice(text: string): MenuChoice {
  const t = clean(text);
  if (!t) return { kind: "ORDER" };

  if (wantsHuman(text)) return { kind: "HUMAN" };

  // A short bare utterance is a spoken keypress. Checked before intent so
  // "two" is the menu choice, while "two large pepperoni" is an order — the
  // distinction is length, because nobody says just "two" to order two of
  // something they haven't named yet.
  const words = t.split(" ").filter(Boolean);
  if (words.length <= 4) {
    if (BARE_ONE.test(t)) return { kind: "ORDER" };
    if (BARE_TWO.test(t)) return { kind: "STATUS" };
    if (BARE_THREE.test(t)) return { kind: "AMEND" };
    if (BARE_FOUR.test(t)) return { kind: "COMPLAINT" };
    if (BARE_FIVE.test(t)) return { kind: "REPEAT" };
  }

  // A complaint outranks everything. Someone whose food never turned up must
  // not be routed into placing another one because they said the word "order".
  if (COMPLAINT_INTENT.some((p) => t.includes(p))) return { kind: "COMPLAINT" };
  // Then amending, before status: "change my order" contains "my order" and
  // would otherwise read as a status enquiry.
  if (AMEND_INTENT.some((p) => t.includes(p))) return { kind: "AMEND" };
  if (REPEAT_INTENT.some((p) => t.includes(p))) return { kind: "REPEAT" };
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
  const tokens = clean(text).split(" ").filter(Boolean);

  // Anything written as actual digits wins. "order 24" is 24, and "four oh
  // one two" typed out as 4012 is 4012.
  const explicit = tokens.filter((t) => /^\d+$/.test(t));
  if (explicit.length) return explicit.join("");

  // A caller reading out "two four oh one" means the digits in that order. A
  // caller saying "twenty four" means the NUMBER twenty-four — and reading it
  // as the digits 2 and 4 happens to give the same answer, but "two hundred
  // and forty" as digits gives 240 by luck and "ninety" gives 90 by none.
  // The tell is whether any word can only appear in a cardinal: a teen, a
  // ten, or a hundred.
  const cardinal = tokens.some((t) => TEENS[t] || TENS[t] || t === "hundred" || t === "thousand");
  if (cardinal) {
    let total = 0;
    let current = 0;
    let saw = false;
    for (const t of tokens) {
      if (WORD_DIGITS[t] && !TENS[t]) {
        current += Number(WORD_DIGITS[t]);
        saw = true;
      } else if (TEENS[t]) {
        current += TEENS[t];
        saw = true;
      } else if (TENS[t]) {
        current += TENS[t];
        saw = true;
      } else if (t === "hundred") {
        current = (current || 1) * 100;
        saw = true;
      } else if (t === "thousand") {
        total += (current || 1) * 1000;
        current = 0;
        saw = true;
      }
    }
    total += current;
    return saw && total > 0 ? String(total) : null;
  }

  const out: string[] = [];
  for (const token of tokens) {
    if (WORD_DIGITS[token]) out.push(WORD_DIGITS[token]);
  }
  const digits = out.join("");
  return digits.length ? digits : null;
}

const TEENS: Record<string, number> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

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
/** Channels whose delivery, and whose customer relationship, are not ours. */
const MARKETPLACES: Record<string, string> = {
  UBER_EATS: "Uber Eats",
  DELIVEROO: "Deliveroo",
  JUST_EAT: "Just Eat",
  TALABAT: "talabat",
  CAREEM: "Careem",
  DOORDASH: "DoorDash",
  GRUBHUB: "Grubhub",
};

/** The customer-facing name of the channel an order came in on, or null when
 *  it is one of the shop's own. */
export function marketplaceName(source?: string | null): string | null {
  return MARKETPLACES[String(source ?? "").toUpperCase()] ?? null;
}

export function spokenOrderStatus(args: {
  status: string;
  fulfillmentType?: string | null;
  minutesAway?: number | null;
  /** orderSource — decides whose driver this is and who can actually help. */
  source?: string | null;
  /** Courier fields, when the platform has told us. */
  courierName?: string | null;
  courierMinutesAway?: number | null;
}): { say: string; transfer?: boolean } {
  const delivery = args.fulfillmentType === "DELIVERY";
  const via = marketplaceName(args.source);

  // A marketplace order is out of the shop's hands the moment it leaves, and
  // saying "we're getting a driver to it" when Uber Eats owns the driver is
  // both wrong and sets up a complaint the shop cannot answer. Name the
  // platform, use their courier when we have it, and send the caller to the
  // people who can actually change something.
  if (via && delivery) {
    const eta =
      args.courierMinutesAway != null && args.courierMinutesAway > 0
        ? ` It should be about ${args.courierMinutesAway} minutes.`
        : "";
    const driver = args.courierName ? ` ${args.courierName} is bringing it.` : "";
    switch (args.status) {
      case "OUT_FOR_DELIVERY":
      case "DISPATCHED":
        return { say: `That's your ${via} order, and it's with the driver now.${driver}${eta}` };
      case "RIDER_ARRIVED":
        return { say: `The ${via} driver is at the shop collecting it right now.` };
      case "PENDING_DISPATCH":
      case "ASSIGNED_DRIVER":
      case "ACCEPTED_BY_DRIVER":
        return { say: `That's your ${via} order. It's ready and a driver is on the way to collect it.${eta}` };
      case "READY":
        return { say: `That's your ${via} order and it's ready — it's waiting for their driver.` };
      case "COMPLETED":
        return { say: `${via} have that one down as delivered.` };
      case "CANCELLED":
      case "REJECTED":
      case "FAILED":
        // The shop cannot refund or reinstate a marketplace order.
        return {
          say: `That ${via} order has been cancelled. ${via} handle the refund on those, so you'll need to go through the app — but let me put you through to the shop if you'd like a word.`,
          transfer: true,
        };
      default:
        return { say: `That's your ${via} order and the kitchen is on it.${eta}` };
    }
  }
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

/**
 * Does this transcript sound like a finished thought?
 *
 * The 1500ms settle exists because Google's engine returned word-scraps
 * seconds apart, and answering each one made the line feel deaf. Whisper does
 * not do that — it returns whole punctuated utterances ("delivery.", "11
 * Follingsby Drive, NE10 8YH.") — so waiting a second and a half to see
 * whether more is coming is a second and a half the caller spends listening to
 * nothing, on every single turn.
 *
 * A punctuated utterance gets the short wait. Anything that trails off keeps
 * the long one, because that is the case the long wait was written for.
 */
export function soundsComplete(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (!/[.!?]$/.test(t)) return false;
  // "Um." and "And." are punctuation around a hesitation, not a finished
  // sentence. Two words is the floor for treating it as one.
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    // …unless it is a whole answer on its own, which on this line it usually
    // is: "delivery.", "yes.", "cash.".
    return /^(yes|no|yeah|nope|delivery|collection|pickup|cash|card|correct|right)[.!?]$/i.test(t);
  }
  // A sentence ending in a conjunction is someone drawing breath.
  return !/\b(and|but|or|so|with|plus|then|also)[.!?]$/i.test(t);
}

/** UK postcode, normalised to "NE10 8YH". Null when it isn't one. */
export function normalisePostcode(raw: string | null | undefined): string | null {
  const compact = String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (compact.length < 5 || compact.length > 7) return null;
  const out = `${compact.slice(0, -3)} ${compact.slice(-3)}`;
  // Standard UK format. Deliberately strict: a "postcode" that is not one is
  // worse than no postcode, because it silently prices the wrong zone.
  return /^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/.test(out) ? out : null;
}

/**
 * Repair a postcode the transcriber clipped, using the shop's own zones.
 *
 * A real call came back as "E10, 8YH" for what the caller said as "NE10 8YH" —
 * the leading letter simply did not survive the audio. We cannot invent a
 * postcode, but we CAN notice that the shop delivers to exactly one area whose
 * outward code ends with what we heard, and that guessing between two would be
 * unforgivable so we do not.
 *
 * Only ever ADDS characters that were dropped from the front. It will not
 * change a character the transcriber did hear.
 */
export function repairPostcode(
  heard: string | null | undefined,
  zonePrefixes: Array<string | null | undefined>,
): string | null {
  const compact = String(heard ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!compact) return null;

  const outward = compact.length > 3 ? compact.slice(0, -3) : compact;
  const inward = compact.length > 3 ? compact.slice(-3) : "";

  const candidates = zonePrefixes
    .map((p) => String(p ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""))
    .filter(Boolean)
    .filter((p) => p !== outward && p.endsWith(outward));

  // Exactly one, or we stay quiet and let the caller be asked again.
  const unique = Array.from(new Set(candidates));
  if (unique.length !== 1) return null;
  return normalisePostcode(`${unique[0]}${inward}`);
}

/**
 * What postcode did the caller actually give us?
 *
 * Repair cannot be a fallback for "that didn't parse", because the failure it
 * exists for parses perfectly well: "E10 8YH" is a real London postcode, and
 * the caller in Gateshead said "NE10 8YH". It looked valid, so a
 * parse-then-fallback order never even tried to fix it.
 *
 * So the question is not "is this a postcode" but "is this a postcode this
 * shop could possibly deliver to". Only when the answer is no do we consider
 * that the transcriber clipped it.
 */
export function resolveHeardPostcode(
  heard: string | null | undefined,
  zonePrefixes: Array<string | null | undefined>,
): string | null {
  const raw = String(heard ?? "").trim();
  if (!raw) return null;

  const normalised = normalisePostcode(raw);
  const prefixes = zonePrefixes
    .map((p) => String(p ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""))
    .filter(Boolean);

  // A shop with no postcode zones (area- or distance-priced) has nothing to
  // check against, so whatever we heard stands.
  if (!prefixes.length) return normalised ?? raw;

  const outward = (normalised ?? raw).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, -3);
  if (prefixes.some((p) => outward.startsWith(p))) return normalised ?? raw;

  return repairPostcode(raw, zonePrefixes) ?? normalised ?? raw;
}

/**
 * Things Whisper says when nobody is talking.
 *
 * Whisper is trained on subtitled video, and on silence or line noise it falls
 * back to the phrases that pad the end of a subtitle track. "Thank you." is by
 * far the most common; it arrived on a real call the caller had not spoken
 * during, and cost a five and a half second model call to answer a sentence
 * nobody said.
 *
 * Matched only as the WHOLE utterance. A caller who really does say "thank
 * you" at the end of an order says it inside a sentence, and is answered.
 */
const WHISPER_GHOSTS = new Set([
  "thank you",
  "thanks",
  "thank you very much",
  "thank you for watching",
  "thanks for watching",
  "thank you for watching!",
  "please subscribe",
  "subtitles by the amara.org community",
  "you",
  "bye",
  "bye.",
  "okay",
  "oh",
  "so",
  "uh",
  "um",
  "hmm",
  "mm",
  ".",
  "...",
]);

/**
 * Did the engine hear something, or is this silence wearing a sentence?
 *
 * Deliberately narrow. Dropping real speech is far worse than answering a
 * ghost, so this only ever matches a short utterance that is EXACTLY one of
 * the known stock phrases.
 */
export function isLikelyHallucination(text: string): boolean {
  const t = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return true;
  return WHISPER_GHOSTS.has(t) || WHISPER_GHOSTS.has(t.replace(/\.+$/, ""));
}

/**
 * Yes or no, when that is genuinely all we asked for.
 *
 * After a read-back the only thing that matters is whether they agreed. Asking
 * a language model to work that out costs two to five seconds on the single
 * most common turn in the call, for a question a regular expression answers
 * correctly. Anything ambiguous returns null and goes to the model, which is
 * what it is actually good at.
 */
export function parseYesNo(text: string): "YES" | "NO" | null {
  const t = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;

  // Only a short utterance. "No, and can I also add chips as well" is a whole
  // turn, not a slot answer, and belongs to the model.
  const words = t.split(" ").filter(Boolean);
  if (words.length > 4) return null;

  // Checked before anything else: "that's wrong" is an unambiguous no that
  // does not begin with one.
  if (/\b(wrong|incorrect|not right|not quite|not correct)\b/.test(t)) return "NO";
  if (/^(no|nope|nah|negative)\b/.test(t)) return "NO";

  // A correction is never agreement, even when it opens with "yeah" — "yeah
  // but make it a large" taken as YES sends the wrong order to the kitchen,
  // which is the exact failure the read-back exists to prevent. Ambiguous, so
  // it goes to the model rather than being guessed either way.
  if (/\b(but|except|actually|instead|change|sorry|also|as well)\b/.test(t)) return null;

  if (
    /^(yes|yeah|yep|yup|yer|aye|correct|thats right|that's right|thats correct|that's correct|right|ok|okay|okey|sure|please do|go ahead|perfect|lovely|spot on|all good|thats it|that's it|sounds good|fine)\b/.test(
      t,
    )
  ) {
    return "YES";
  }
  return null;
}

/**
 * Collection or delivery, when that is the question we just asked.
 *
 * This is the very first thing a caller says after pressing 1, and it has
 * exactly two answers. Sending it to a language model — prompt, menu, tools,
 * a tool call to record the choice, then a second round trip to say the next
 * line — is two to four seconds to understand the word "delivery".
 */
/** Levenshtein. Small and local — the menu matcher has its own. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

export function parseFulfillment(text: string): "DELIVERY" | "PICKUP" | null {
  const t = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  // Longer than a short answer means they said something else as well, and
  // that belongs to the model.
  const tokens = t.split(" ").filter(Boolean);
  if (tokens.length > 5) return null;

  const delivery = /\b(deliver|delivery|delivered|delivering|to my house|to my home|bring it)\b/.test(t);
  const pickup = /\b(collect|collection|collecting|pick up|pickup|pick it up|takeaway|take away|come in|coming in|myself)\b/.test(t);
  // Both, or neither, is genuinely ambiguous — ask properly rather than guess
  // a delivery charge onto someone who is walking in.
  if (delivery !== pickup) return delivery ? "DELIVERY" : "PICKUP";
  if (delivery && pickup) return null;

  // Nothing matched outright, so try it by sound before giving up. A real
  // transcript of "delivery" was "Very very" — the front of the word simply
  // did not survive, and "very" IS the sound of the back half of it.
  //
  // Only reached when the plain words found nothing, which is what keeps "for
  // collection" safe: "for" sounds like the end of "delivery" too, and there
  // the word "collection" has already decided it.
  const heardIn = (word: string) => {
    const target = soundFold(word);
    return tokens.some((token) => {
      if (token.length < 3) return false;
      const fold = soundFold(token);
      return fold.length >= 2 && target.includes(fold);
    });
  };
  const soundsDelivery = heardIn("delivery");
  const soundsPickup = heardIn("collection");
  if (soundsDelivery !== soundsPickup) return soundsDelivery ? "DELIVERY" : "PICKUP";

  // Last resort: the whole utterance against the whole word. A real transcript
  // was "De livello." — the word survived nearly intact but arrived split in
  // two, so nothing token-shaped could see it, and the turn went to the model
  // along with every turn after it.
  const joined = tokens.join("");
  const closeTo = (word: string) => {
    const d = editDistance(joined, word);
    return d / Math.max(joined.length, word.length) <= 0.35;
  };
  const nearDelivery = closeTo("delivery");
  const nearPickup = closeTo("collection") || closeTo("pickup");
  if (nearDelivery === nearPickup) return null;
  return nearDelivery ? "DELIVERY" : "PICKUP";
}

/**
 * A postcode anywhere in what the caller said.
 *
 * Asked for a postcode, plenty of people give the whole address — a real one
 * was "Five sunny dead arrived, and eight three seven two l l", which is "5
 * Sunningdale Drive, NE37 2LL" as the transcriber managed it. Making somebody
 * repeat just the postcode after that is infuriating, and unnecessary: the
 * postcode is at the end, so the end is where to look.
 *
 * Windows are tried longest first and each has to survive full validation, so
 * a shorter window only wins when the longer ones were not postcodes at all.
 */
export function findPostcodeIn(
  text: string,
  zonePrefixes: Array<string | null | undefined> = [],
): string | null {
  const compact = (normaliseSpokenReference(text) || String(text ?? ""))
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (compact.length < 5) return null;

  const prefixes = zonePrefixes
    .map((p) => String(p ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""))
    .filter(Boolean);
  const servable = (pc: string) =>
    !prefixes.length ||
    prefixes.some((p) => pc.replace(/\s+/g, "").startsWith(p));

  // Two passes, and the order is the whole point. "N E" came back as "n a",
  // which makes NA37 2LL — a perfectly valid postcode, in a different county,
  // that this shop does not deliver to. A mis-heard letter is far likelier
  // than a caller ringing a takeaway two hundred miles away, so a window that
  // the shop can actually serve wins over one that merely parses.
  for (let len = Math.min(8, compact.length); len >= 5; len--) {
    const window = compact.slice(-len);
    const direct = normalisePostcode(window);
    if (direct && servable(direct)) return direct;
    const repaired = repairPostcode(window, zonePrefixes);
    if (repaired) return repaired;
  }

  // Nothing servable. Someone genuinely outside the area still gets their real
  // postcode back — and hears "we don't deliver there", which is the truth.
  for (let len = Math.min(8, compact.length); len >= 5; len--) {
    const direct = normalisePostcode(compact.slice(-len));
    if (direct) return direct;
  }
  return null;
}

/**
 * A whole first line — house and street together — out of one utterance.
 *
 * Used when the caller is giving the street themselves, which is what happens
 * after the looked-up one was wrong. "11 Fellside Road" has to survive intact;
 * taking only the number out of it loses the half that matters.
 */
export function addressLineFrom(said: string): string | null {
  const t = String(said ?? "")
    .replace(/[^a-zA-Z0-9\s'-]/g, " ")
    .replace(/\b(it'?s|its|number|no|i'?m at|im at|at|the address is|address is)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;

  const words = t.split(" ").filter(Boolean);
  // A number on its own is a house number, not a line — that is a different
  // question and has its own parser.
  if (words.length < 2) return null;

  // Spoken numbers become digits so "eleven Fellside Road" reads properly.
  //
  // Greedy over the leading words, because a house number is often two of
  // them. Taking only the first turned "twenty two Fellside Road" into "20
  // Two Fellside Road" — a number that doesn't exist on a street that then
  // couldn't be found.
  let head = words[0] ?? "";
  let taken = 1;
  if (words.length > 2) {
    const pair = `${words[0]} ${words[1]}`;
    const asPair = parseSpokenNumber(pair);
    if (asPair && asPair !== parseSpokenNumber(words[0] ?? "")) {
      head = pair;
      taken = 2;
    }
  }
  const asNumber = parseSpokenNumber(head);
  const rest = words.slice(taken).join(" ");
  const line =
    asNumber && asNumber.length <= 4 && !/^\d/.test(head)
      ? `${asNumber} ${rest}`
      : words.join(" ");

  return line.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Cash or card, when that is the question we just asked.
 *
 * The other one-word answer in the call, and the one that gates placing the
 * order — so it is also the slowest turn to sit through.
 */
export function parsePayment(text: string): "CASH" | "CARD" | null {
  const t = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  if (t.split(" ").filter(Boolean).length > 5) return null;

  const cash = /\b(cash|money|notes|coins|on delivery|when it arrives|at the shop|in person)\b/.test(t);
  const card = /\b(card|credit|debit|visa|mastercard|link|online|apple pay|google pay|by phone)\b/.test(t);
  if (cash === card) return null;
  return cash ? "CASH" : "CARD";
}

/**
 * Whatever the caller reads out when we ask for their order.
 *
 * There is no single "order number" in this system, and pretending there is
 * was the bug. A caller can hold any of:
 *
 *   - the sequential number we read back at the end of the call ("24")
 *   - a marketplace reference off a confirmation email ("940324216")
 *   - a collection code
 *   - the tail of the id shown in the dashboard URL ("…v24kiod"), which is
 *     what a shop reads out when they are looking at the order on screen
 *
 * So this returns both readings and lets the lookup try each. Returning a code
 * as well as a number is not a guess — they are checked against different
 * columns, and an id suffix is high-entropy enough that a wrong match is not a
 * realistic worry.
 */
export function parseOrderReference(text: string): {
  number: string | null;
  forms: string[];
} {
  // Is the caller SPELLING, rather than saying a number?
  //
  // This matters more than it looks. "S h r three p." — a caller reading out
  // #SHR3P — has a "three" in it, and reading that as the number 3 finds order
  // number 3, which belongs to somebody else and gets read out loud. A stray
  // digit lifted from a spelled reference is not a near miss; it is the wrong
  // customer's dinner.
  //
  // The tell is a lone letter. Nobody says a single letter while giving a
  // plain number, and everybody says several while spelling one out.
  const spelling = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .some((t) => /^[a-z]$/.test(t));

  const number = spelling ? null : parseSpokenNumber(text);
  const forms = [
    normaliseSpokenReference(text),
    compactReference(text),
    number,
  ].filter((f): f is string => !!f && f.length >= 3);
  return { number, forms: Array.from(new Set(forms)) };
}

/** Everything that is not a letter or a digit, thrown away. */
function compactReference(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Characters spoken by name: "dash", "hyphen", "hash", and the digits. */
const SPOKEN_CHARS: Record<string, string> = {
  dash: "",
  hyphen: "",
  minus: "",
  hash: "",
  slash: "",
  dot: "",
  point: "",
  space: "",
  zero: "0",
  oh: "0",
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
 * What a caller means when they SPELL an order number out.
 *
 * From two real calls: "#Y5BJH" was read as "y five b j h", and "#SIM-I2DC" as
 * "S i m dash i two d c." The transcriber writes the NAME of each character —
 * "five", "dash", "two" — so stripping punctuation and closing up the spaces
 * gives "yfivebjh" and "simdashitwodc", which match nothing.
 *
 * Spelling is also the thing we ASK them to do when a reference is not found,
 * so this is the reading most likely to be on the second attempt.
 */
export function normaliseSpokenReference(text: string): string {
  const tokens = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  let out = "";
  for (const token of tokens) {
    if (token in SPOKEN_CHARS) {
      out += SPOKEN_CHARS[token];
      continue;
    }
    // A lone letter is a spelled character; a longer run is the thing itself
    // ("sim", "24kiod"), already written the way it looks.
    out += token;
  }
  return out;
}

/**
 * Does what the caller said name this order?
 *
 * Compared on NORMALISED forms rather than in SQL, because the identifiers
 * carry punctuation the spoken version cannot ("SIM-I2DC" against "simi2dc")
 * and no `endsWith` in the database will bridge that.
 *
 * `endsWith` rather than equality because someone reading an id off a screen
 * says the tail of it, and a suffix of four or more characters out of a cuid
 * is specific enough not to be a coincidence.
 */
export function referenceMatches(forms: string[], identifier?: string | null): boolean {
  const target = compactReference(identifier ?? "");
  if (!target) return false;
  return forms.some((form) => {
    if (form.length < 3) return false;
    if (target === form) return true;
    // A short form has to be the WHOLE identifier — "24" must not match every
    // order whose id happens to end in 24.
    return form.length >= 4 && target.endsWith(form);
  });
}

/**
 * An order reference, said so a caller can check it against their screen.
 *
 * Letters and digits are separated — "S, H, R, 3, P" — because the whole
 * point of reading it back is that a wrong match is caught in the second it
 * takes to hear it, not after the shop has been told the wrong thing about
 * somebody else's order. Suffix matching is forgiving by design, so the
 * read-back is what keeps it honest.
 */
export function spokenReference(value: string | number | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .split("")
    .join(", ");
}

/**
 * The reference for an order as the ORDERS BOARD shows it.
 *
 * Deliberately the same expression the dashboard renders — displayId, else the
 * sequential number, else the last six of the id — because the caller is very
 * often a member of staff reading a row off that screen, and anything else we
 * say back is, to them, a different order.
 *
 * The three channels genuinely differ: POS and the marketplaces carry a
 * displayId, and orders taken by this phone line carry neither a displayId nor
 * a sequential number, so they show the id tail. Reading the whole cuid back
 * instead is what made it sound like the wrong order had been found.
 */
export function boardReference(order: {
  displayId?: string | null;
  orderNumber?: number | string | null;
  id?: string | null;
}): string {
  if (order.displayId) return String(order.displayId);
  if (order.orderNumber != null && order.orderNumber !== "") {
    return String(order.orderNumber);
  }
  return String(order.id ?? "").slice(-6);
}

/**
 * The street out of a full first line — "11 Follingsby Drive" → "Follingsby
 * Drive".
 *
 * Used to read a street back off a postcode lookup, where every result on the
 * postcode shares the street and only the number differs.
 */
/**
 * Are these two the same street, said differently?
 *
 * "Sunningdale Drive" and "Sunnyndale Drive" are one street and a transcript;
 * "Sunningdale Drive" and "Fellside Road" are two streets. The phonetic fold
 * is the same one the menu matcher uses, for the same reason — the vowels are
 * the first thing a phone line loses.
 */
export function sameStreet(a?: string | null, b?: string | null): boolean {
  const fold = (s?: string | null) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .map(soundFold)
      .join(" ");
  const fa = fold(a);
  const fb = fold(b);
  return !!fa && fa === fb;
}

const STREET_TYPES = new Set([
  "road", "rd", "street", "st", "drive", "dr", "avenue", "ave", "lane", "ln",
  "close", "way", "crescent", "court", "gardens", "garden", "place", "terrace",
  "grove", "walk", "rise", "view", "hill", "park", "square", "row", "mews",
  "parade", "green", "croft", "vale", "chase", "dene", "bank", "meadows",
]);

/**
 * Does this read as a street name, or just as words?
 *
 * Used before overwriting a street the caller already agreed to, so the bar is
 * "plausible street", not "in the gazetteer". "Twenty two" must not qualify —
 * it is a house number that the line parser leaves as a stray word — while
 * "Loch Lomond" and "High Croft" must, because real streets near the shop are
 * named exactly like that with no Road or Drive on the end.
 */
export function looksLikeStreet(text?: string | null): boolean {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return false;
  if (words.some((w) => STREET_TYPES.has(w))) return true;
  // No street type, so it has to at least be more than one real word and not
  // be a spoken number in disguise.
  if (words.length < 2) return false;
  return !words.some((w) => parseSpokenNumber(w) !== null);
}

/**
 * What they said, with the postcode taken out.
 *
 * A postcode is a unique key and a street name is not, so the two halves of
 * "five Sunningdale Drive, NE37 2LL" want completely different treatment. This
 * separates them.
 */
export function stripPostcode(said: string): string {
  const found = findPostcodeIn(said);
  const text = String(said ?? "");
  if (!found) return text.trim();
  // Take out whatever spelled or spoken form actually carried it, rather than
  // the tidy version — "n e three seven two l l" is not in the string as
  // "NE37 2LL".
  const compact = found.replace(/\s+/g, "");
  const letters = compact.slice(0, 2);
  const pattern = new RegExp(
    `[,\\s]*\\b${letters.split("").join("[\\s.]*")}[\\s.]*` +
      `(?:[a-z0-9][\\s.]*){3,9}$`,
    "i",
  );
  const trimmed = text.replace(pattern, "");
  // An EMPTY remainder is the right answer, not a failed one: it means the
  // caller said a postcode and nothing else, which is a thing people do.
  if (trimmed.length < text.length) return trimmed.trim();
  // Fall back to removing the tidy form if it is literally present.
  return text
    .replace(new RegExp(found.replace(/\s/g, "\\s*"), "i"), "")
    .replace(/[,\s]+$/, "")
    .trim();
}

export function streetOf(line1?: string | null): string | null {
  const t = String(line1 ?? "").trim();
  if (!t) return null;
  // Drop a leading house number, or a number-with-letter like "11a", or a
  // flat/unit prefix. What is left is the street.
  const street = t
    .replace(/^(flat|apartment|apt|unit|no\.?)\s+\S+\s*,?\s*/i, "")
    // The optional letter binds to the DIGITS ("11a"), never across the space
    // — an earlier version matched the "F" of "11 Follingsby" and served up
    // "ollingsby Drive".
    .replace(/^\d+[a-z]?(\s*[-–]\s*\d+[a-z]?)?\s*,?\s+/i, "")
    .trim();
  return street.length >= 3 ? street : null;
}

/**
 * A house number or name out of what the caller said.
 *
 * "eleven", "11", "number 11", "11a", "flat 2", "Rose Cottage" — all of them
 * are the answer to "what's the house number or name?", and the only wrong
 * move is to insist on a digit.
 */
export function houseNumberFrom(said: string): string | null {
  const raw = String(said ?? "").trim();
  if (!raw) return null;

  const cleaned = raw
    .replace(/[^a-zA-Z0-9\s'-]/g, " ")
    .replace(/\b(number|no|it'?s|its|house|the|my|i'?m at|at)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;

  // A spoken number: "eleven" → 11, "twenty four" → 24. Same parser the order
  // numbers use, so "four" is a 4 here too.
  const spoken = parseSpokenNumber(cleaned);
  const words = cleaned.split(" ").filter(Boolean);

  // "11a" and "11" survive as written; a spelled number becomes digits.
  const first = words[0] ?? "";
  if (/^\d+[a-z]?$/i.test(first)) {
    // "11a" or "11". Keep any flat prefix that came with it.
    return words.length > 1 && /^(flat|apartment|apt|unit)$/i.test(first)
      ? words.slice(0, 2).join(" ")
      : first;
  }
  if (/^(flat|apartment|apt|unit)$/i.test(first) && words[1]) {
    return `${first} ${words[1]}`;
  }
  if (spoken && spoken.length <= 4) return spoken;

  // A house NAME. Kept as said, capitalised, because "Rose Cottage" is as
  // valid an answer as "11" and refusing it strands whoever lives there.
  if (words.length <= 4 && /^[a-z' -]+$/i.test(cleaned)) {
    return cleaned.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
  return null;
}
