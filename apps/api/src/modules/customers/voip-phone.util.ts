// Phase BB-3 — extract the CALLER's number from a VoIP provider's
// incoming-call webhook body. Providers disagree on field names:
//   Twilio:  { From: "+447788…", Caller: "+447788…", To: … }   (form-encoded)
//   sipgate: { from: "4477…", to: … }
//   Telnyx:  { data: { payload: { from: { phone_number: "+44…" } } } }
//   generic: { from } / { caller } / { caller_id } / { phone } / { callerNumber }
// Pure + defensive so a new provider is a one-line addition with a test.
export function extractVoipPhone(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, any>;
  const candidates: unknown[] = [
    b.From,
    b.Caller,
    b.from,
    b.caller,
    b.caller_id,
    b.callerId,
    b.callerNumber,
    b.phone,
    b.data?.payload?.from?.phone_number, // Telnyx
    typeof b.from === "object" ? b.from?.phone_number : undefined,
  ];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const trimmed = c.trim();
    // Keep leading +, drop spacing/dashes/parens.
    const cleaned = trimmed.replace(/[\s\-()]/g, "");
    const repaired = undoubleNumber(cleaned);
    if (/^\+?\d{7,15}$/.test(repaired)) return repaired;
  }
  return null;
}

/**
 * Repair a number that arrived with a fragment of itself stuck on the end.
 *
 * A caller-ID sender that reads a notification carrying the number twice can
 * join them into one over-long run and then cut it at its own length limit.
 * That is how 07940053972 reached a till as 079400539720794 — the tail 0794
 * is the head of the same number, sliced at 15 digits.
 *
 * The repetition IS the evidence, and it is what makes this a repair rather
 * than a guess: we only shorten when the leftover is a genuine prefix of what
 * comes before it. "07940053972" + "0794" qualifies; an unfamiliar 14-digit
 * international number does not, and is returned untouched.
 *
 * Longest head first, so a number that merely starts with its own opening
 * digits is not cut short.
 *
 * This lives on the server because the senders are Android apps in the field.
 * Fixing the app is the real fix; this stops every device that has not been
 * updated from putting a number that does not exist in front of staff.
 */
export function undoubleNumber(cleaned: string): string {
  const plus = cleaned.startsWith("+");
  const digits = plus ? cleaned.slice(1) : cleaned;
  if (!/^\d+$/.test(digits)) return cleaned;
  // Nothing to repair: already a plausible single number.
  if (digits.length <= 11) return cleaned;

  // Two guards, both learned the hard way on +441388436844:
  //
  //  - The leftover must be at least 3 digits. A 1- or 2-digit tail matches
  //    the head of almost any number by coincidence, and shortening on that
  //    turned a perfectly good 12-digit international number into an 11-digit
  //    one that was never dialled.
  //  - The head must still be a whole number (10+ digits), not a fragment.
  const MIN_TAIL = 3;
  const MIN_HEAD = 10;

  for (let head = digits.length - 1; head >= MIN_HEAD; head--) {
    const tail = digits.slice(head);
    if (tail.length < MIN_TAIL) continue;
    // The leftover has to be shorter than the number it repeats, or we are
    // looking at two different numbers rather than one that overran.
    if (tail.length >= head) continue;
    if (digits.slice(0, head).startsWith(tail)) {
      return (plus ? "+" : "") + digits.slice(0, head);
    }
  }
  return cleaned;
}
