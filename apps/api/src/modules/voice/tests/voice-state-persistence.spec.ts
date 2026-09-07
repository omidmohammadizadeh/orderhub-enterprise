// Everything the caller is mid-answering has to survive a reload.
//
// coerceState rebuilds VoiceState field by field out of whatever the database
// returns. A field that is declared but not rebuilt is not a type error and
// not a test failure — it just quietly vanishes between events, and the only
// place it shows up is a live call.
//
// It cost one: the keypad question "press 1 for yes, or 2 for no" was asked
// and saved, the next event rebuilt the state without pendingConfirm, and the
// caller's 2 arrived to find nothing waiting for it. So it was read as the
// opening menu's "press 2 for an order update" and they were transferred out
// of the order they were placing.
//
// The answer to a question ALWAYS arrives on a later event than the question,
// so this is load-bearing for every field, not just that one.

import { readFileSync } from "fs";
import { join } from "path";
import { coerceState } from "../voice-ai.service";

const source = readFileSync(join(__dirname, "..", "voice-ai.service.ts"), "utf8");

const declaredFields = (): string[] => {
  const start = source.indexOf("export interface VoiceState");
  const end = source.indexOf("export function emptyState");
  return [...source.slice(start, end).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
};

const rebuiltFields = (): string[] => {
  const start = source.indexOf("export function coerceState");
  const end = source.indexOf("\n}\n", start);
  return [...source.slice(start, end).matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]!);
};

describe("state that has to survive a reload", () => {
  it("rebuilds every field VoiceState declares", () => {
    const missing = declaredFields().filter((f) => !rebuiltFields().includes(f));
    expect(missing).toEqual([]);
  });

  it("carries an unanswered keypad question through a save and load", () => {
    const saved = JSON.parse(
      JSON.stringify({
        turns: [],
        cart: { items: [] },
        stage: "ORDER",
        pendingConfirm: { intent: "usual", asked: true },
      }),
    );

    expect(coerceState(saved).pendingConfirm).toEqual({
      intent: "usual",
      asked: true,
      answered: undefined,
    });
  });

  it("carries the answer once it has been given", () => {
    for (const answered of ["YES", "NO"] as const) {
      const back = coerceState({
        turns: [],
        cart: { items: [] },
        stage: "ORDER",
        pendingConfirm: { intent: "address", asked: true, answered },
      });
      expect(back.pendingConfirm?.answered).toBe(answered);
    }
  });

  it("throws away a keypad answer that is not one of ours", () => {
    const back = coerceState({
      turns: [],
      cart: { items: [] },
      stage: "ORDER",
      pendingConfirm: { intent: "nonsense", asked: true, answered: "MAYBE" },
    });
    expect(back.pendingConfirm?.answered).toBeUndefined();
    expect(["usual", "address", "order"]).toContain(back.pendingConfirm?.intent);
  });
});

describe("a digit while a keypad question is outstanding", () => {
  // The other half of the same live failure. Even with the state persisted,
  // the gateway asks "is this call past the opening menu?" before it will
  // treat a digit as an answer to anything — and a call that has only been
  // asked "same as last time?" has no cart, no pending item and no slot, so
  // it looked like a caller still sitting on the main menu. Their 2 became
  // "press 2 for an order update" and transferred them out of their order.
  const svc = () => {
    const { VoiceService } = require("../voice.service");
    const s: any = Object.create(VoiceService.prototype);
    s.logger = { log() {}, warn() {}, error() {} };
    return s;
  };

  it("counts as past the menu", async () => {
    const s = svc();
    s.loadByControlId = async () => ({
      call: { id: "c1" },
      ctx: {},
      state: {
        cart: { items: [] },
        turns: [],
        pendingConfirm: { intent: "usual", asked: true },
      },
    });

    expect(await s.pastTheMenu("cc1")).toBe(true);
  });

  it("is answered as the confirmation, not as a menu choice", async () => {
    const s = svc();
    const state: any = {
      cart: { items: [] },
      turns: [],
      pendingConfirm: { intent: "usual", asked: true },
    };
    s.loadByControlId = async () => ({ call: { id: "c1" }, ctx: {}, state });
    s.save = async () => {};

    const out = await s.realtimeDigit("cc1", "2");

    expect(out?.confirmed).toEqual({ intent: "usual", answered: "NO" });
    expect(state.pendingConfirm.answered).toBe("NO");
  });

  it("takes 1 as the yes", async () => {
    const s = svc();
    const state: any = {
      cart: { items: [] },
      turns: [],
      pendingConfirm: { intent: "address", asked: true },
    };
    s.loadByControlId = async () => ({ call: { id: "c1" }, ctx: {}, state });
    s.save = async () => {};

    const out = await s.realtimeDigit("cc1", "1");

    expect(out?.confirmed).toEqual({ intent: "address", answered: "YES" });
  });
});
