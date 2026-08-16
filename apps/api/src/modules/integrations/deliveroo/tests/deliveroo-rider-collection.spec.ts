// Deliveroo rider lifecycle — the shapes that actually land on the wire.
//
// Every log below is copied from production webhook_events for Castle Grill
// orders #5049 and #5116 (16 Aug 2026). The headline fact they encode:
// across 40 rider events, `rider_delivered` NEVER appears. Deliveroo stops
// sharing the rider with the merchant at pickup, so the merchant-side log
// ends at rider_unassigned with lat/lon 0,0 and then repeats unchanged.
//
// These tests exist so that stays pinned. If a future Deliveroo release does
// start sending rider_delivered, the "real payload" cases keep passing and
// the delivered cases below prove we still honour it.

import {
  furthestRiderStage,
  furthestRiderRawStatus,
  riderCollectedFromLog,
} from "../deliveroo-order.mappers";

/** #5049 — rider collected and left. No rider_delivered, ever. */
const ORDER_5049 = [
  "rider_assigned",
  "rider_arrived",
  "rider_confirmed_at_restaurant",
  "rider_unassigned",
];

/** #5116 — dropped 6s after assignment, re-assigned 10 min later. */
const ORDER_5116 = [
  "rider_assigned",
  "rider_unassigned",
  "rider_assigned",
  "rider_arrived",
];

describe("riderCollectedFromLog", () => {
  // An unassign is an ABANDONMENT, not a pickup. #5049 and #5116 are both
  // riders who dropped the job; #4952 shows a real collection sends a proper
  // forward stage. Treating the unassign as a pickup would mark a live order
  // Out for delivery while its food is still on the pass with no rider.
  it("does NOT infer collection from an unassign after arrival (#5049)", () => {
    expect(riderCollectedFromLog(ORDER_5049)).toBe(false);
  });

  it("does NOT infer collection from an unassign before arrival (#5116)", () => {
    expect(riderCollectedFromLog(ORDER_5116)).toBe(false);
  });

  it("stays false while the rider is still on the way", () => {
    expect(riderCollectedFromLog(["rider_assigned"])).toBe(false);
    expect(riderCollectedFromLog(["rider_assigned", "rider_arrived"])).toBe(false);
  });

  it("is true only on a genuine in-transit or delivered stage", () => {
    expect(riderCollectedFromLog(["rider_assigned", "rider_in_transit"])).toBe(true);
    expect(
      riderCollectedFromLog(["rider_assigned", "rider_arrived", "rider_delivered"]),
    ).toBe(true);
  });

  it("handles an empty log", () => {
    expect(riderCollectedFromLog([])).toBe(false);
    expect(riderCollectedFromLog([undefined, null])).toBe(false);
  });

  it("a later unassign can't undo a real collection", () => {
    expect(
      riderCollectedFromLog(["rider_arrived", "rider_in_transit", "rider_unassigned"]),
    ).toBe(true);
  });
});

describe("furthestRiderRawStatus — what the board shows", () => {
  it("keeps the last MEANINGFUL stage, not the trailing unassign (#5049)", () => {
    // This is the bug the operator saw: the board said "not assigned" for a
    // rider who was standing in the shop.
    expect(furthestRiderRawStatus(ORDER_5049)).toBe("rider_confirmed_at_restaurant");
  });

  it("ignores a mid-log unassign too (#5116)", () => {
    expect(furthestRiderRawStatus(ORDER_5116)).toBe("rider_arrived");
  });

  it("prefers the later entry within the same stage", () => {
    expect(
      furthestRiderRawStatus(["rider_arrived", "rider_confirmed_at_restaurant"]),
    ).toBe("rider_confirmed_at_restaurant");
  });

  it("returns null when nothing maps, so the caller can fall back", () => {
    expect(furthestRiderRawStatus(["rider_unassigned"])).toBeNull();
    expect(furthestRiderRawStatus([])).toBeNull();
  });

  it("never regresses below a delivered stage", () => {
    expect(
      furthestRiderRawStatus(["rider_in_transit", "rider_delivered", "rider_unassigned"]),
    ).toBe("rider_delivered");
  });
});

describe("furthestRiderStage against the real logs", () => {
  it("#5049 maps no further than the restaurant on its own", () => {
    // Collection has to be INFERRED — the log itself never gets past
    // RIDER_ARRIVED, which is exactly why the order stuck.
    expect(furthestRiderStage(ORDER_5049)).toBe("RIDER_ARRIVED");
  });

  it("#5116 likewise", () => {
    expect(furthestRiderStage(ORDER_5116)).toBe("RIDER_ARRIVED");
  });

  it("still completes when rider_delivered does arrive", () => {
    expect(
      furthestRiderStage(["rider_assigned", "rider_delivered", "rider_unassigned"]),
    ).toBe("COMPLETED");
  });
});
