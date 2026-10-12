import { applyCredit, buildLines, checkoutTotal, linesForCheckout, staffDoes, summariseLines } from "../salon-lines";
import {
  canMoveStatus,
  guestCanChange,
  makeSalonReference,
  mergeSalonSettings,
  readSalonSettings,
  tradeDefaults,
} from "../salon-settings";

const svc = (over: Partial<any> = {}) => ({
  id: "fade",
  name: "Skin fade",
  price: 22,
  priceFrom: false,
  durationMins: 30,
  bufferMins: 5,
  processingStartMins: null,
  processingMins: null,
  depositType: "NONE",
  depositValue: null,
  bookableOnline: true,
  isActive: true,
  requiresPatchTest: false,
  addons: [{ id: "beard", name: "Beard trim", price: 8, durationMins: 15 }],
  ...over,
});

describe("salon lines", () => {
  it("prices with the barber's own price and the chosen add-ons", () => {
    const lines = buildLines({
      wanted: [{ serviceId: "fade", addonIds: ["beard", "beard", "nope"] }],
      services: [svc()],
      staff: { id: "sam", name: "Sam", serviceIds: [], priceOverrides: { fade: 26 }, bookableOnline: true, isActive: true },
      online: false,
    });
    expect(lines[0]).toMatchObject({ price: 26, addons: [{ id: "beard", price: 8 }] });
    expect(summariseLines(lines)).toBe("Skin fade (+ Beard trim)");
  });

  it("refuses switched-off and phone-only services with a guest-readable reason", () => {
    expect(() => buildLines({ wanted: [{ serviceId: "fade" }], services: [svc({ isActive: false })], online: false })).toThrow(
      /isn't available/,
    );
    expect(() => buildLines({ wanted: [{ serviceId: "fade" }], services: [svc({ bookableOnline: false })], online: true })).toThrow(
      /can't be booked online/,
    );
    expect(() => buildLines({ wanted: [], services: [svc()], online: true })).toThrow(/at least one/);
  });

  it("knows who does what", () => {
    expect(staffDoes({ serviceIds: [] }, ["a", "b"])).toBe(true);
    expect(staffDoes({ serviceIds: ["a"] }, ["a", "b"])).toBe(false);
  });

  it("splits add-ons into their own receipt lines", () => {
    const lines = linesForCheckout(
      buildLines({ wanted: [{ serviceId: "fade", addonIds: ["beard"] }], services: [svc()], online: false }),
      "Jay",
    );
    expect(lines.map((l) => [l.name, l.unitPrice])).toEqual([
      ["Skin fade", 22],
      ["+ Beard trim", 8],
    ]);
    expect(lines[0]!.notes).toBe("with Jay");
  });

  it("takes a deposit off the lines, first line first, never below zero", () => {
    const { lines, applied } = applyCredit(
      [
        { name: "Skin fade", unitPrice: 22, quantity: 1 },
        { name: "+ Beard trim", unitPrice: 8, quantity: 1 },
      ],
      25,
      "deposit",
    );
    expect(applied).toBe(25);
    expect(lines.map((l) => l.unitPrice)).toEqual([0, 5]);
    expect(checkoutTotal(lines)).toBe(5);
    expect(applyCredit([{ name: "x", unitPrice: 10, quantity: 1 }], 50, "d").applied).toBe(10);
  });

  it("keeps pence whole on a part-credited multi-quantity line", () => {
    const { lines } = applyCredit([{ name: "Clay", unitPrice: 10, quantity: 3 }], 5, "Discount");
    expect(lines[0]).toMatchObject({ name: "Clay ×3", unitPrice: 25, quantity: 1 });
  });
});

describe("salon settings", () => {
  it("fills defaults and clamps nonsense", () => {
    const s = readSalonSettings({ salon: { slotStepMins: 7, leadTimeMins: -1, trade: "nails", reminderHoursBefore: 500 } });
    expect(s).toMatchObject({ slotStepMins: 15, leadTimeMins: 0, trade: "NAILS", reminderHoursBefore: 72 });
    expect(readSalonSettings(null).onlineBookingEnabled).toBe(false);
  });

  it("merges a partial update", () => {
    const s = mergeSalonSettings({ salon: { trade: "HAIR", rebookAfterDays: 42 } }, { onlineBookingEnabled: true });
    expect(s).toMatchObject({ trade: "HAIR", rebookAfterDays: 42, onlineBookingEnabled: true });
  });

  it("barbers get the queue, salons don't", () => {
    expect(tradeDefaults("BARBER").queueEnabled).toBe(true);
    expect(tradeDefaults("HAIR").queueEnabled).toBe(false);
  });

  it("lets a guest change for free only outside the window", () => {
    const s = readSalonSettings({ salon: { cancellationWindowHours: 24 } });
    const now = new Date("2026-10-13T09:00:00Z");
    expect(guestCanChange(s, new Date("2026-10-15T09:00:00Z"), now)).toEqual({ allowed: true, free: true });
    expect(guestCanChange(s, new Date("2026-10-13T20:00:00Z"), now)).toEqual({ allowed: true, free: false });
    expect(guestCanChange(s, new Date("2026-10-13T08:00:00Z"), now).allowed).toBe(false);
    expect(guestCanChange({ ...s, allowGuestChanges: false }, new Date("2026-10-15T09:00:00Z"), now).allowed).toBe(false);
  });

  it("only allows sensible status moves", () => {
    expect(canMoveStatus("CONFIRMED", "CHECKED_IN")).toBe(true);
    expect(canMoveStatus("NO_SHOW", "CONFIRMED")).toBe(true);
    expect(canMoveStatus("NO_SHOW", "IN_SERVICE")).toBe(false);
    expect(canMoveStatus("COMPLETED", "CANCELLED")).toBe(false);
    expect(canMoveStatus("CONFIRMED", "CONFIRMED")).toBe(false);
  });

  it("makes readable references without lookalike characters", () => {
    expect(makeSalonReference()).toMatch(/^S-[A-HJ-NP-Z2-9]{6}$/);
  });
});
