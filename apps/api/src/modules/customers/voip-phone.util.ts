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
    if (/^\+?\d{7,15}$/.test(cleaned)) return cleaned;
  }
  return null;
}
