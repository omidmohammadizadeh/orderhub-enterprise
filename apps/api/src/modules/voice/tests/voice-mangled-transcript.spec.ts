// The call where every answer came back in the wrong language.
//
// 7 September, 12:41 — the caller pressed 1 and then answered four questions
// out loud. This is what the transcriber made of them:
//
//   said  "Would you like the same as last time — chips and garlic sauce…?"
//   heard "Svensk."                                   ← they said no
//   said  "Sorry, are you still there?"
//   heard "Телигов."                                  ← they said yes
//   said  "Are you still at 11 Sunningdale Drive?"
//   heard "Svensk."
//   said  "Sorry, I didn't catch that. Are you still at 11 Sunningdale Drive?"
//   [caller hung up]
//
// The speech-to-speech model heard all of it correctly — it is listening to
// the audio. The sidecar transcriber is a small model on an 8kHz phone line
// and it re-guesses the language every utterance. Consent was gated on THAT,
// so a yes became unobtainable and the same question was asked until the
// caller gave up.
//
// Two rules come out of it: a transcript nobody can read is not a refusal, and
// a question speech has already failed to answer is asked again on the keypad.

import { VoiceAiService } from "../voice-ai.service";

const ai = () => {
  const s: any = Object.create(VoiceAiService.prototype);
  s.logger = { log() {}, warn() {}, error() {} };
  return s;
};

describe("a transcript nobody can read", () => {
  it.each([
    ["Svensk.", true],
    ["Телигов.", false],
    ["डिलिवरी", false],
    ["Sienos.", true],
    ["Но.", false],
  ])("treats %s as unclear, never as a refusal", (heard, readable) => {
    const verdict = ai().agreed({ __heard: heard, __heardFresh: true, __heardReadable: readable });
    expect(verdict.ok).toBe(false);
    expect(verdict.unclear).toBe(true);
  });

  it("still hears a real no, however long the sentence", () => {
    for (const no of [
      "no",
      "no I don't want the same as last time",
      "no that address is wrong I've moved",
      "not the same as last time please",
    ]) {
      const verdict = ai().agreed({ __heard: no, __heardFresh: true, __heardReadable: true });
      expect(verdict.ok).toBe(false);
      expect(verdict.unclear).toBeFalsy(); // a no is an ANSWER, not a failure to hear
    }
  });

  it("still takes a plain yes", () => {
    const verdict = ai().agreed({ __heard: "yes", __heardFresh: true, __heardReadable: true });
    expect(verdict.ok).toBe(true);
  });

  it("lets a keypress settle it when speech cannot", () => {
    const s = ai();
    const state: any = { cart: { items: [] }, turns: [] };

    // Speech failed, so the question moves to the keypad.
    const ask = s.confirmByKeypad(state, "usual", "Would you like the same as last time?");
    expect(ask.sayNow).toBe(
      "Would you like the same as last time? Press 1 for yes, or 2 for no.",
    );

    // And now the SAME unreadable transcript no longer decides anything.
    state.pendingConfirm.answered = "YES";
    expect(s.agreed({ __heard: "Svensk.", __heardReadable: false }, state).ok).toBe(true);

    state.pendingConfirm.answered = "NO";
    const no = s.agreed({ __heard: "Телигов.", __heardReadable: false }, state);
    expect(no.ok).toBe(false);
    expect(no.unclear).toBeFalsy();
  });

  it("does not ask the same unanswerable question twice", () => {
    // The loop, stated as a property: whatever the transcriber returns, the
    // second attempt is never the first attempt again.
    const s = ai();
    const state: any = { cart: { items: [] }, turns: [] };
    const first = s.confirmByKeypad(state, "address", "Are you still at 11 Follingsby Drive?");
    expect(first.sayNow).toMatch(/Press 1 for yes, or 2 for no/);
    expect(state.pendingConfirm).toMatchObject({ intent: "address", asked: true });
    // Until that keypress lands, nothing acts.
    expect(first.result).toMatch(/do NOT act until it arrives/i);
  });
});
