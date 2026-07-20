import {
  mapDeliverooOrderStatus,
  mapDeliverooRiderStatus,
  deliverooSiteIdFrom,
  deliverooOrderIdFrom,
} from "../deliveroo-order.mappers";

// Phase BA-3b — the routing service leans on these pure mappers. They're the
// riskiest bit (Deliveroo's status vocabulary + drifting payload field names),
// so they're pinned here without needing the Nest DI container.

describe("mapDeliverooOrderStatus", () => {
  it("maps kitchen + terminal statuses", () => {
    expect(mapDeliverooOrderStatus("accepted")).toBe("ACCEPTED");
    expect(mapDeliverooOrderStatus("confirmed")).toBe("ACCEPTED");
    expect(mapDeliverooOrderStatus("in_kitchen")).toBe("PREPARING");
    expect(mapDeliverooOrderStatus("ready_for_collection")).toBe("READY");
    expect(mapDeliverooOrderStatus("delivered")).toBe("COMPLETED");
    expect(mapDeliverooOrderStatus("rejected")).toBe("REJECTED");
    expect(mapDeliverooOrderStatus("failed")).toBe("FAILED");
  });

  it("treats both cancel spellings as CANCELLED", () => {
    expect(mapDeliverooOrderStatus("canceled")).toBe("CANCELLED");
    expect(mapDeliverooOrderStatus("cancelled")).toBe("CANCELLED");
  });

  it("is case-insensitive", () => {
    expect(mapDeliverooOrderStatus("ACCEPTED")).toBe("ACCEPTED");
  });

  it("returns null for the ingest state + unknowns (no forward move)", () => {
    expect(mapDeliverooOrderStatus("placed")).toBeNull();
    expect(mapDeliverooOrderStatus("pending")).toBeNull();
    expect(mapDeliverooOrderStatus("something_new")).toBeNull();
    expect(mapDeliverooOrderStatus(undefined)).toBeNull();
  });
});

describe("mapDeliverooRiderStatus", () => {
  it("maps the documented rider vocabulary", () => {
    expect(mapDeliverooRiderStatus("assigned")).toBe("ASSIGNED_DRIVER");
    expect(mapDeliverooRiderStatus("confirmed_at_restaurant")).toBe(
      "RIDER_ARRIVED",
    );
    expect(mapDeliverooRiderStatus("collected")).toBe("OUT_FOR_DELIVERY");
    expect(mapDeliverooRiderStatus("delivered")).toBe("COMPLETED");
  });

  it("maps the official rider.status_update vocabulary incl. NFC check-in", () => {
    expect(mapDeliverooRiderStatus("rider_assigned")).toBe("ASSIGNED_DRIVER");
    expect(mapDeliverooRiderStatus("rider_arrived")).toBe("RIDER_ARRIVED");
    expect(mapDeliverooRiderStatus("rider_confirmed_at_restaurant")).toBe(
      "RIDER_ARRIVED",
    );
    // The new NFC on-site check-in must NOT push the order to out-for-delivery.
    expect(mapDeliverooRiderStatus("rider_check_in")).toBe("RIDER_ARRIVED");
    expect(mapDeliverooRiderStatus("rider_in_transit")).toBe("OUT_FOR_DELIVERY");
    expect(mapDeliverooRiderStatus("rider_delivered")).toBe("COMPLETED");
    // Case-insensitive.
    expect(mapDeliverooRiderStatus("RIDER_CHECK_IN")).toBe("RIDER_ARRIVED");
  });

  it("does not advance the order on rider_unassigned", () => {
    expect(mapDeliverooRiderStatus("rider_unassigned")).toBeNull();
  });

  it("maps the Base44-audit aliases", () => {
    expect(mapDeliverooRiderStatus("en_route")).toBe("ASSIGNED_DRIVER");
    expect(mapDeliverooRiderStatus("en_route_to_customer")).toBe(
      "OUT_FOR_DELIVERY",
    );
    expect(mapDeliverooRiderStatus("completed")).toBe("COMPLETED");
  });

  it("returns null for unassigned/pending/unknown", () => {
    expect(mapDeliverooRiderStatus("pending")).toBeNull();
    expect(mapDeliverooRiderStatus("unassigned")).toBeNull();
    expect(mapDeliverooRiderStatus(undefined)).toBeNull();
  });
});

describe("deliverooSiteIdFrom", () => {
  it("reads the common site-id field layouts", () => {
    expect(deliverooSiteIdFrom({ location_id: "site-1" })).toBe("site-1");
    expect(deliverooSiteIdFrom({ location: { id: "site-2" } })).toBe("site-2");
    expect(deliverooSiteIdFrom({ restaurant: { id: "site-3" } })).toBe("site-3");
    expect(deliverooSiteIdFrom({}, { location_id: "site-4" })).toBe("site-4");
  });

  it("trims and returns null when absent", () => {
    expect(deliverooSiteIdFrom({ location_id: "  site-5 " })).toBe("site-5");
    expect(deliverooSiteIdFrom({})).toBeNull();
    expect(deliverooSiteIdFrom({ location_id: "" })).toBeNull();
  });
});

describe("deliverooOrderIdFrom", () => {
  it("reads id from any of the event layouts", () => {
    expect(deliverooOrderIdFrom({ id: "o-1" })).toBe("o-1");
    expect(deliverooOrderIdFrom({ order_id: "o-2" })).toBe("o-2");
    expect(deliverooOrderIdFrom({}, { order_id: "o-3" })).toBe("o-3");
    expect(deliverooOrderIdFrom({}, { order: { id: "o-4" } })).toBe("o-4");
    expect(deliverooOrderIdFrom({})).toBeNull();
  });
});
