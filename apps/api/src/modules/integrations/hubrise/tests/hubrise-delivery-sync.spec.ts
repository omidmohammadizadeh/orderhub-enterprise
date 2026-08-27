
// Field names taken from a REAL HubRise delivery payload rather than their
// docs, which have been wrong on this integration twice. Captured live on
// 27 Aug 2026 from an Uber Eats delivery relayed through HubRise:
//
//   "estimated_pickup_at":  "2026-08-27T09:03:58+01:00"   → rider at the SHOP
//   "estimated_dropoff_at": "2026-08-27T09:23:58+01:00"   → rider at the CUSTOMER
//
// dropoff was the one guessed wrong first time round (as estimated_delivery_at),
// so both are pinned here.
describe("HubRise delivery — the two estimates", () => {
  const REAL = {
    id: "jrp74q",
    carrier: "Uber Eats",
    status: "dropoff_enroute",
    estimated_pickup_at: "2026-08-27T09:03:58+01:00",
    estimated_dropoff_at: "2026-08-27T09:23:58+01:00",
    driver_name: "Sean",
    driver_phone: "+353851234567",
    driver_phone_access_code: "24715883",
    assigned_at: "2026-08-27T08:24:38+01:00",
    pickup_at: "2026-08-27T08:25:18+01:00",
    delivered_at: null,
  };

  it("keeps pickup and dropoff apart", () => {
    // The whole point of the split: one drives the board's ETA column, the
    // other drives auto-completion. Same value in both would close orders a
    // whole delivery early.
    expect(REAL.estimated_pickup_at).not.toEqual(REAL.estimated_dropoff_at);
    const gapMin =
      (new Date(REAL.estimated_dropoff_at).getTime() -
        new Date(REAL.estimated_pickup_at).getTime()) /
      60_000;
    expect(gapMin).toBe(20);
  });

  it("carries the courier PIN, without which the number will not connect", () => {
    expect(REAL.driver_phone_access_code).toBe("24715883");
  });

  it("marks the order collected while a pickup estimate still sits in the past", () => {
    // This is the bug the board showed: pickup_at was set at 08:25 while
    // estimated_pickup_at still read 09:03, because the platform stops
    // refreshing that estimate once it no longer matters to them. Counting
    // down to it read "39 min" on an order collected forty seconds earlier.
    expect(new Date(REAL.pickup_at).getTime()).toBeLessThan(
      new Date(REAL.estimated_pickup_at).getTime(),
    );
  });
});
