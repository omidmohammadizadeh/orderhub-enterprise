import { JetGoDispatchService } from "../jet-go-dispatch.service";
import { JetGoWebhookService } from "../jet-go-webhook.service";

// What the wallet pays for a JET Go delivery.
//
// Under the reseller contract the JET Go account is OURS, so JET invoices us
// £4.25–£9.20 per completed delivery and we owe it whether or not the shop pays.
// The wallet therefore has to recover the courier cost as well as our markup.
// Charging the flat markup alone — which is what Stuart and Uber Direct do,
// because THEIR merchants hold the account — lost about £4.85 on a 1.5-mile drop.

type Row = Record<string, any>;

const MARKUP = 50;

function svc(cfgOver: Row = {}) {
  const s: any = Object.create(JetGoDispatchService.prototype);
  s.wallet = {
    dispatchFeeMinor: () => MARKUP,
    dispatchFeeMinorFor: jest.fn().mockResolvedValue(MARKUP),
  };
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    s,
    cfg: { reseller: true, collectPointId: "cp-1", ...cfgOver } as any,
  };
}

const estimate = (fee: unknown) => ({ requestId: "req-1", dynamicDeliveryFee: fee }) as any;

describe("what the wallet pays", () => {
  it("charges the courier price PLUS the markup on our own account", () => {
    // JET's 1.5–2 mile band is £5.80. The shop pays that plus our 50p.
    const { s, cfg } = svc();
    expect(s.walletChargeMinor(cfg, estimate(580), MARKUP)).toBe(630);
  });

  it.each([
    [425, 475], // under 0.5 mi
    [535, 585], // 1–1.5 mi
    [920, 970], // 5.5 mi+
  ])("band %ip → wallet %ip", (courier, expected) => {
    const { s, cfg } = svc();
    expect(s.walletChargeMinor(cfg, estimate(courier), MARKUP)).toBe(expected);
  });

  it("charges only the markup when the merchant holds their own JET account", () => {
    // Payment Processor / Intermediary in the contract: JET bills them for the
    // courier, so we take what Stuart and Uber Direct take.
    const { s, cfg } = svc({ reseller: false });
    expect(s.walletChargeMinor(cfg, estimate(580), MARKUP)).toBe(MARKUP);
  });

  it("never silently charges the markup alone on our own account", () => {
    // The whole bug: a reseller delivery billed at 50p while JET invoices £5.80.
    const { s, cfg } = svc();
    expect(s.walletChargeMinor(cfg, estimate(580), MARKUP)).not.toBe(MARKUP);
  });

  it.each([[undefined], [null], ["", ], ["abc"], [-1], [NaN]])(
    "refuses to book when JET's price reads as %p",
    (bad) => {
      // Booking commits us to an invoice. Without a price we cannot collect for
      // it, so the delivery does not happen.
      const { s, cfg } = svc();
      expect(() => s.walletChargeMinor(cfg, estimate(bad), MARKUP)).toThrow(/courier price/i);
    },
  );

  it("rounds a fractional price rather than dropping the pence", () => {
    const { s, cfg } = svc();
    expect(s.walletChargeMinor(cfg, estimate(580.6), MARKUP)).toBe(631);
  });

  it("still charges the markup on a free delivery", () => {
    const { s, cfg } = svc();
    expect(s.walletChargeMinor(cfg, estimate(0), MARKUP)).toBe(MARKUP);
  });
});

// ── refunds have to return the same money ────────────────────────────────

function webhookSvc() {
  const s: any = Object.create(JetGoWebhookService.prototype);
  s.wallet = { dispatchFeeMinor: () => MARKUP };
  return s;
}

describe("what a refund returns", () => {
  it("returns what was actually charged, not the flat markup", () => {
    const s = webhookSvc();
    const order = { metadata: { jetGo: { walletChargedMinor: 630 } } };
    expect(s.walletChargedMinor(order)).toBe(630);
  });

  it("falls back to the markup for an order from before we recorded it", () => {
    const s = webhookSvc();
    expect(s.walletChargedMinor({ metadata: {} })).toBe(MARKUP);
    expect(s.walletChargedMinor({})).toBe(MARKUP);
  });

  it("returns zero when the charge was waived, not the markup", () => {
    // A waived dispatch took nothing; refunding 50p would mint money.
    const s = webhookSvc();
    expect(s.walletChargedMinor({ metadata: { jetGo: { walletChargedMinor: 0 } } })).toBe(0);
  });

  it("ignores a corrupt recorded amount rather than refunding nonsense", () => {
    const s = webhookSvc();
    expect(s.walletChargedMinor({ metadata: { jetGo: { walletChargedMinor: -5 } } })).toBe(MARKUP);
    expect(s.walletChargedMinor({ metadata: { jetGo: { walletChargedMinor: "lots" } } })).toBe(MARKUP);
  });
});

// ── the statement line ────────────────────────────────────────────────────

describe("what the wallet statement says", () => {
  function dispatchSvc(reseller: boolean) {
    const debits: any[] = [];
    const s: any = Object.create(JetGoDispatchService.prototype);
    s.wallet = {
      dispatchFeeMinor: () => MARKUP,
      dispatchFeeMinorFor: jest.fn().mockResolvedValue(MARKUP),
      isDispatchChargeWaived: jest.fn().mockResolvedValue(false),
      debitForDispatch: jest.fn(async (a: any) => {
        debits.push(a);
        return { chargedMinor: a.amountMinor, balanceAfterMinor: 0 };
      }),
      refundDispatch: jest.fn().mockResolvedValue(undefined),
    };
    s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    s.activity = { record: jest.fn() };
    s.geocoding = { geocode: jest.fn().mockResolvedValue(null) };
    s.client = {
      estimate: jest
        .fn()
        .mockResolvedValue({ requestId: "req-1", dynamicDeliveryFee: 600 }),
      createDelivery: jest.fn().mockResolvedValue({}),
    };
    s.load = jest.fn().mockResolvedValue({
      order: {
        id: "o1",
        tenantId: "t1",
        locationId: "loc1",
        displayId: "A-1",
        customerName: "Sam",
        customerPhone: "+447700900123",
        customerInfo: {},
        deliveryAddress: { line1: "1 Mann Island", city: "Liverpool", postcode: "L3 1BP" },
        deliveryLat: 53.4,
        deliveryLng: -2.99,
        items: [{ quantity: 1 }],
        total: "12.00",
        metadata: {},
      },
      location: { id: "loc1", name: "Shop", country: "GB", currency: "GBP", prepTime: 20 },
      cfg: { reseller, collectPointId: "cp-1", market: "UK", environment: "sandbox", active: true },
    });
    s.db = () => ({ order: { update: jest.fn().mockResolvedValue({}) } });
    return { s, debits };
  }

  it("spells out the courier price and our fee on our own account", async () => {
    // "Courier dispatch fee (650p)" gives the operator no way to reconcile one
    // debit against Just Eat's monthly invoice. The split has to be on the line.
    const { s, debits } = dispatchSvc(true);
    await s.dispatch({ orderId: "o1", tenantId: "t1" });
    expect(debits).toHaveLength(1);
    expect(debits[0].amountMinor).toBe(650);
    expect(debits[0].description).toBe("JET Go courier £6.00 + 50p OrderHub fee");
  });

  it("says only our fee when the merchant's own account paid the courier", async () => {
    const { s, debits } = dispatchSvc(false);
    await s.dispatch({ orderId: "o1", tenantId: "t1" });
    expect(debits[0].amountMinor).toBe(MARKUP);
    expect(debits[0].description).toBe("JET Go dispatch fee (50p)");
  });
});
