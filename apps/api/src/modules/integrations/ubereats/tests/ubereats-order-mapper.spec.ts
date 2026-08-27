import { mapUberEatsOrder } from "../ubereats-order.mappers";


// Uber sends the courier on the ORDER, unlike Deliveroo and Just Eat which
// name their rider later on a rider event. The field path is read across
// several plausible shapes because the Order Fulfillment spec was not to hand
// — Uber Direct, Uber's own courier API, uses {name, phone_number}, so that is
// the primary guess, and the raw block is kept so a real order can correct it.
describe("mapUberEatsOrder — the courier", () => {
  const withCourier = (courier: unknown) =>
    mapUberEatsOrder({
      id: "o1",
      store: { id: "s1" },
      fulfillment_type: "DELIVERY_BY_UBER",
      deliveries: [{ courier }],
      carts: [],
    } as never);

  it("reads Uber Direct's shape — name and phone_number", () => {
    const out = withCourier({ name: "Sam R.", phone_number: "+441234567890" });
    expect((out as any).courierName).toBe("Sam R.");
    expect((out as any).courierPhone).toBe("+441234567890");
  });

  it("keeps the PIN, without which the number does not connect", () => {
    // Uber anonymises courier numbers the same way it does eaters': the call
    // only completes once the PIN is entered after it.
    const out = withCourier({
      name: "Sam R.",
      contact: { phone: { number: "+441234567890", pin_code: "4821" } },
    });
    expect((out as any).courierPhone).toBe("+441234567890");
    expect((out as any).courierPhoneAccessCode).toBe("4821");
  });

  it("builds a name from first and last when there is no single name", () => {
    const out = withCourier({ first_name: "Sam", last_name: "Rahman" });
    expect((out as any).courierName).toBe("Sam Rahman");
  });

  it("keeps the raw block so a real order can settle the shape", () => {
    const raw = { name: "Sam R.", something_unexpected: true };
    const out = withCourier(raw);
    expect((out.metadata as any).uberCourierRaw).toEqual(raw);
  });

  it("says nothing at all when no courier is assigned yet", () => {
    // Common and correct: the order exists before a courier is allocated, and
    // writing empty strings here would blank a name a later event supplies.
    const out = mapUberEatsOrder({
      id: "o1",
      store: { id: "s1" },
      fulfillment_type: "DELIVERY_BY_UBER",
      deliveries: [{}],
      carts: [],
    } as never);
    expect((out as any).courierName).toBeUndefined();
    expect((out.metadata as any).uberCourierRaw).toBeUndefined();
  });
});
