import { HubRiseAdapter } from "../adapters/hubrise.adapter";

// Marketplace orders were arriving marked Scheduled, mid-service, on the board
// AND on the printed ticket.
//
// Real Uber Eats order g2y4b3g (BEST KEBAB, 4 Sep): created 19:50:47, with
// expected_time 20:49:47 — 59 minutes out — and `asap: true`. HubRise stamps
// expected_time on every order, and a busy shop or an unassigned courier
// pushes it well past the 45-minute rule we used to guess with. The customer
// had asked for it now.

const adapter = new HubRiseAdapter();

function hubriseOrder(over: Record<string, any> = {}) {
  const created = new Date();
  return {
    id: "g2y4b3g",
    ref: "4c7f5d63",
    status: "new",
    service_type: "delivery",
    channel: "Uber Eats",
    connection_name: "BEST KEBAB",
    created_at: created.toISOString(),
    customer: { first_name: "Jaimie-lee", last_name: "Y." },
    items: [
      {
        sku_ref: "kebab",
        product_name: "Doner Kebab",
        quantity: "1.0",
        price: "17.75 GBP",
        subtotal: "17.75 GBP",
      },
    ],
    total: "19.75 GBP",
    ...over,
  };
}

/** Minutes from now, as HubRise sends it. */
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

const parse = (order: any) => adapter.normalize(order, "loc-001") as any;

describe("HubRise ASAP orders are not scheduled", () => {
  it("an asap order an hour out is NOT scheduled — order g2y4b3g", () => {
    const c = parse(
      hubriseOrder({ asap: true, expected_time: inMinutes(59) }),
    );
    expect(c.scheduledFor).toBeUndefined();
  });

  it("still not scheduled when the ETA is hours out, if asap is true", () => {
    const c = parse(hubriseOrder({ asap: true, expected_time: inMinutes(180) }));
    expect(c.scheduledFor).toBeUndefined();
  });

  it("a genuine pre-order — asap false, well ahead — IS scheduled", () => {
    const c = parse(
      hubriseOrder({ asap: false, expected_time: inMinutes(180) }),
    );
    expect(c.scheduledFor).toBeInstanceOf(Date);
  });

  it("falls back to the time when the channel omits asap", () => {
    const far = parse(hubriseOrder({ expected_time: inMinutes(180) }));
    expect(far.scheduledFor).toBeInstanceOf(Date);
    const soon = parse(hubriseOrder({ expected_time: inMinutes(20) }));
    expect(soon.scheduledFor).toBeUndefined();
  });

  it("no expected_time at all is never scheduled", () => {
    expect(parse(hubriseOrder()).scheduledFor).toBeUndefined();
  });
});
