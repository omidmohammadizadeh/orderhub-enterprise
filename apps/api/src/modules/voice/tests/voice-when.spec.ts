// The shop's clock.
//
// Everything else this phone line does happens now: an order is cooked in
// twenty minutes wherever the server runs. A table on Friday at seven is
// Friday at seven in the restaurant, and the API runs in UTC. An hour out
// over a British summer and a party arrives while the table is still being
// eaten off.

import { whenInShop, shopNow, spokenWhen, spokenDay } from "../voice-when";

const LONDON = "Europe/London";
const DUBAI = "Asia/Dubai";

describe("a time on the restaurant's wall", () => {
  it("reads British summer time as an hour ahead of UTC", () => {
    // 11 September is BST: 7pm in the dining room is 18:00 UTC.
    expect(whenInShop("2026-09-11T19:00", LONDON)!.toISOString()).toBe("2026-09-11T18:00:00.000Z");
  });

  it("and winter as UTC itself", () => {
    expect(whenInShop("2026-12-11T19:00", LONDON)!.toISOString()).toBe("2026-12-11T19:00:00.000Z");
  });

  it("gets the evening either side of the clocks going back", () => {
    // The 2026 UK change is 25 October. Saturday evening is still BST,
    // Sunday evening is not — the same wall-clock hour, an hour apart.
    expect(whenInShop("2026-10-24T19:00", LONDON)!.toISOString()).toBe("2026-10-24T18:00:00.000Z");
    expect(whenInShop("2026-10-25T19:00", LONDON)!.toISOString()).toBe("2026-10-25T19:00:00.000Z");
  });

  it("works for a shop that is not in Britain at all", () => {
    // The Gulf keeps one offset all year.
    expect(whenInShop("2026-09-11T19:00", DUBAI)!.toISOString()).toBe("2026-09-11T15:00:00.000Z");
    expect(whenInShop("2026-12-11T19:00", DUBAI)!.toISOString()).toBe("2026-12-11T15:00:00.000Z");
  });

  it("refuses anything it cannot read rather than guessing an hour", () => {
    for (const bad of ["", "Friday at seven", "next week", "2026-09-11", "tomorrow 7pm"]) {
      expect(whenInShop(bad, LONDON)).toBeNull();
    }
  });

  it("survives the round trip, which is what the model is asked to do", () => {
    const now = new Date("2026-09-11T18:00:00.000Z");
    expect(shopNow(LONDON, now)).toBe("2026-09-11T19:00");
    expect(whenInShop(shopNow(LONDON, now), LONDON)!.getTime()).toBe(now.getTime());
    expect(shopNow(DUBAI, now)).toBe("2026-09-11T22:00");
    expect(whenInShop(shopNow(DUBAI, now), DUBAI)!.getTime()).toBe(now.getTime());
  });
});

describe("the time said out loud", () => {
  const friday = new Date("2026-09-11T18:00:00.000Z");

  it("leads with the day, because that is the part a caller checks", () => {
    expect(spokenWhen(friday, LONDON)).toBe("Friday 11 September at 7pm");
    expect(spokenDay(friday, LONDON)).toBe("Friday 11 September");
  });

  it("says the minutes only when there are any", () => {
    expect(spokenWhen(new Date("2026-09-11T18:30:00.000Z"), LONDON)).toBe("Friday 11 September at 7:30pm");
    expect(spokenWhen(new Date("2026-09-11T11:00:00.000Z"), LONDON)).toBe("Friday 11 September at 12pm");
  });

  it("says it in the shop's day, not the server's", () => {
    // Half past midnight in Dubai is still the evening before in London.
    const late = new Date("2026-09-11T20:30:00.000Z");
    expect(spokenWhen(late, DUBAI)).toBe("Saturday 12 September at 12:30am");
    expect(spokenWhen(late, LONDON)).toBe("Friday 11 September at 9:30pm");
  });
});
