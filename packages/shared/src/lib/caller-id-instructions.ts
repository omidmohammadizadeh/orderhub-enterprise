/**
 * The wording we send a shop's phone provider to switch caller ID on.
 *
 * It lives here rather than inline in the dashboard because it is not
 * decoration — each of the three rules in the webhook message is here because
 * getting it wrong cost us a callout, and a rewrite that drops one would look
 * like a harmless copy edit:
 *
 *   • INCOMING / RINGING event only. A provider that posted on every call
 *     event put a caller card on the till when a call ENDED — minutes after
 *     staff had hung up, while they were serving somebody else. "Phantom
 *     popups" was the complaint; this sentence is the fix.
 *   • The CALLER's number, not the shop's own. Plenty of systems substitute
 *     their own number when they pass a call on, and then every call shows the
 *     same number and the feature does nothing.
 *   • The key in the x-voip-key HEADER, not the URL. Web addresses are written
 *     into logs by every proxy they pass through; headers are not.
 *
 * Tested, deliberately — see caller-id-instructions.spec.ts in the API suite.
 */

/** Route A: the provider posts to us on an incoming call. */
export function webhookProviderMessage(url: string, token: string | null): string {
  return [
    "Hello,",
    "",
    "We use a till system that shows the caller's name on screen when the phone rings. Please send it a webhook when a call comes in:",
    "",
    `  POST  ${url}`,
    `  Header:  x-voip-key: ${token ?? "<ask the shop for its key>"}`,
    '  Body:    JSON containing the caller\'s number, e.g. {"from": "+447700900123"}',
    "",
    "Three things matter:",
    "",
    "1. Send it on the INCOMING / RINGING event ONLY — not answered, ended, missed or voicemail. Those arrive after the call is over and would put a caller on screen while staff are serving somebody else.",
    "2. Send the CALLER's number, not our own number.",
    "3. Put the key in the x-voip-key header rather than in the web address. Addresses get written into logs along the way; headers don't.",
    "",
    "Field names: we accept from, caller, caller_id, phone, From or Caller, so whatever your system already sends is most likely fine. No reply body is needed — we answer 200 and that's the end of it.",
    "",
    "Thanks.",
  ].join("\n");
}

/**
 * Route B: the provider has no webhooks, so they ring a number of ours
 * alongside the shop's own line and the ringing itself carries the number.
 *
 * The two questions at the bottom are the whole point of the message. They are
 * what decide whether this route works AT ALL for a given provider, and both
 * have to be a yes with one real shop before it is promised to any other.
 */
export function simultaneousRingProviderMessage(voiceNumber: string | null): string {
  const number = voiceNumber?.trim() || "<the number we've assigned this shop>";
  return [
    "Hello,",
    "",
    "When our shop number rings, please also ring this number at the same time (simultaneous ring / twinning):",
    "",
    `  ${number}`,
    "",
    "It is a display-only line for our till system: it never answers, so it will not take the call away from us and nobody is charged for it. Staff keep answering the shop phone exactly as they do now.",
    "",
    "Two questions before we set this up:",
    "",
    "1. Can you ring a second, OUTSIDE number at the same time as ours? We need it ringing simultaneously — a divert that only fires after our line has rung out is too late to be any use.",
    "2. Will the CALLER's number be passed to that second number, or do you replace it with our own? If it arrives as our own number, the screen shows the same number on every call and the feature does nothing — please pass the original caller ID through.",
    "",
    "Thanks.",
  ].join("\n");
}
