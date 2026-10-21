import {
  normalizeStoreState,
  pauseEndsAt,
  StoreStatusUnavailableError,
} from "../store-control";

// The three platforms answer "are you trading" in three vocabularies, and the
// pause-end time is the field each one treats differently. These pin the two
// places that are easy to get quietly wrong.

describe("normalizeStoreState", () => {
  it("reads each platform's own word for trading", () => {
    expect(normalizeStoreState("ONLINE")).toBe("OPEN"); // Uber Eats
    expect(normalizeStoreState("OPEN")).toBe("OPEN"); // Deliveroo
    expect(normalizeStoreState("open")).toBe("OPEN");
    expect(normalizeStoreState(" Online ")).toBe("OPEN");
  });

  it("reads each platform's own word for paused", () => {
    expect(normalizeStoreState("OFFLINE")).toBe("CLOSED");
    expect(normalizeStoreState("CLOSED")).toBe("CLOSED");
    expect(normalizeStoreState("SUSPENDED")).toBe("CLOSED");
  });

  it("never guesses: an unrecognised word is UNKNOWN, not CLOSED", () => {
    // A shop shown as closed while it is trading sends staff hunting for a
    // problem that does not exist.
    expect(normalizeStoreState("PENDING_REVIEW")).toBe("UNKNOWN");
    expect(normalizeStoreState("")).toBe("UNKNOWN");
    expect(normalizeStoreState(null)).toBe("UNKNOWN");
    expect(normalizeStoreState(undefined)).toBe("UNKNOWN");
  });
});

describe("pauseEndsAt", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;

  it("uses the operator's end time when it is still ahead", () => {
    const until = new Date("2026-10-09T18:00:00Z");
    expect(pauseEndsAt(until, DAY, now)).toBe(until);
  });

  it("falls back when there is no end time", () => {
    expect(pauseEndsAt(null, DAY, now).toISOString()).toBe(
      "2026-10-10T12:00:00.000Z",
    );
    expect(pauseEndsAt(undefined, DAY, now).toISOString()).toBe(
      "2026-10-10T12:00:00.000Z",
    );
  });

  it("falls back on a time in the past rather than resuming instantly", () => {
    // Uber rejects it, and "resume immediately" is not what the operator
    // meant by pausing the shop.
    const stale = new Date("2026-10-09T09:00:00Z");
    expect(pauseEndsAt(stale, DAY, now).toISOString()).toBe(
      "2026-10-10T12:00:00.000Z",
    );
  });
});

describe("StoreStatusUnavailableError", () => {
  it("names the platform that cannot be read back", () => {
    const err = new StoreStatusUnavailableError("JUST_EAT");
    expect(err.platform).toBe("JUST_EAT");
    expect(err.message).toContain("JUST_EAT");
  });
});
