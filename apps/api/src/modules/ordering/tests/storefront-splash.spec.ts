// Which welcome screen a phone customer sees today. Decided on the shop's
// calendar, and an occasion beats the everyday picture.

import { activeSplash, shopToday } from "../storefront-splash";

const settings = (splashes: any[]) => ({ storefrontSplash: { splashes } });
const everyday = { id: "a", name: "Everyday", imageUrl: "https://x/a.jpg", enabled: true };
const xmas = {
  id: "b",
  name: "Christmas",
  imageUrl: "https://x/b.jpg",
  enabled: true,
  startDate: "2026-12-01",
  endDate: "2026-12-26",
  headline: "  Christmas boxes are here  ",
};
const at = (iso: string) => new Date(iso);

describe("the storefront welcome screen", () => {
  it("shows nothing when the shop has none", () => {
    expect(activeSplash({}, "Europe/London")).toBeNull();
    expect(activeSplash(null, "Europe/London")).toBeNull();
  });

  it("shows the everyday one outside an occasion", () => {
    const s = activeSplash(settings([everyday, xmas]), "Europe/London", at("2026-11-20T12:00:00Z"));
    expect(s?.id).toBe("a");
  });

  it("lets an occasion take over for its dates, then hands back", () => {
    const tz = "Europe/London";
    expect(activeSplash(settings([everyday, xmas]), tz, at("2026-12-01T00:30:00Z"))?.id).toBe("b");
    expect(activeSplash(settings([everyday, xmas]), tz, at("2026-12-26T23:30:00Z"))?.id).toBe("b");
    expect(activeSplash(settings([everyday, xmas]), tz, at("2026-12-27T00:30:00Z"))?.id).toBe("a");
  });

  it("reads the date on the shop's calendar, not UTC", () => {
    // 21:30 UTC on 30 Nov is already 1 Dec in Dubai.
    expect(shopToday("Asia/Dubai", at("2026-11-30T21:30:00Z"))).toBe("2026-12-01");
    expect(activeSplash(settings([xmas]), "Asia/Dubai", at("2026-11-30T21:30:00Z"))?.id).toBe("b");
    expect(activeSplash(settings([xmas]), "Europe/London", at("2026-11-30T21:30:00Z"))).toBeNull();
  });

  it("skips one that is switched off", () => {
    expect(activeSplash(settings([{ ...everyday, enabled: false }]), "Europe/London")).toBeNull();
  });

  it("sends only what the page needs, trimmed", () => {
    const s = activeSplash(settings([xmas]), "Europe/London", at("2026-12-10T12:00:00Z"));
    expect(s).toEqual({ id: "b", imageUrl: "https://x/b.jpg", headline: "Christmas boxes are here", subline: null });
  });
});
