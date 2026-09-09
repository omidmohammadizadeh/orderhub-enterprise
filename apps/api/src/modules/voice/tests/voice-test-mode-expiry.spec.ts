import { testModeActive } from "../voice-context.service";

// Test mode answers calls without charging. It used to be a plain boolean, so
// a location switched to it during setup answered free calls forever — and
// nobody ever noticed, because everything worked. The shop was simply never
// billed. It now lapses, and the fail-safe direction is billing.

const NOW = new Date("2026-09-09T12:00:00Z");
const iso = (days: number) =>
  new Date(NOW.getTime() + days * 86_400_000).toISOString();

describe("voice test mode expiry", () => {
  it("is off when the box was never ticked", () => {
    expect(testModeActive({}, undefined, "loc", NOW)).toBe(false);
    expect(
      testModeActive({ voiceTestMode: false }, undefined, "loc", NOW),
    ).toBe(false);
  });

  it("is on while the window is still open", () => {
    expect(
      testModeActive(
        { voiceTestMode: true, voiceTestModeUntil: iso(7) },
        undefined,
        "loc",
        NOW,
      ),
    ).toBe(true);
  });

  it("lapses once the window closes, so the shop starts paying", () => {
    expect(
      testModeActive(
        { voiceTestMode: true, voiceTestModeUntil: iso(-1) },
        undefined,
        "loc",
        NOW,
      ),
    ).toBe(false);
  });

  it("treats a flag with NO expiry as lapsed", () => {
    // The whole point: an old row, or one written by something that does not
    // know about the window, must not buy free calls forever.
    expect(
      testModeActive({ voiceTestMode: true }, undefined, "loc", NOW),
    ).toBe(false);
  });

  it("treats an unreadable expiry as lapsed rather than as forever", () => {
    expect(
      testModeActive(
        { voiceTestMode: true, voiceTestModeUntil: "whenever" },
        undefined,
        "loc",
        NOW,
      ),
    ).toBe(false);
  });

  it("says so in the log when it lapses, naming the location", () => {
    const warn = jest.fn();
    testModeActive(
      { voiceTestMode: true, voiceTestModeUntil: iso(-3) },
      { warn } as any,
      "loc_42",
      NOW,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("loc_42");
    expect(warn.mock.calls[0][0]).toContain("charged");
  });
});
