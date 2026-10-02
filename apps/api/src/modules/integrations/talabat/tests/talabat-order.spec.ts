import { signTalabatJwt, verifyTalabatJwt } from "../talabat-jwt";
import { talabatOrderKind, transformTalabatOrder } from "../talabat-order.transformer";
import { rollUpPromotions, summarizeTalabatDiscounts } from "../talabat-promotions";
import { talabatAcceptanceTime, talabatRejectReason } from "../talabat-order-sync.service";
import { TALABAT_AFTER_ACCEPT_REASONS, TALABAT_REJECT_REASONS } from "../talabat-types";
import { GENERIC_ORDER_EXAMPLE, ITEM_LEVEL_DISCOUNT_EXAMPLE } from "./talabat-spec-examples";

describe("Talabat middleware JWT", () => {
  // Their own example: HS512, { service: "middleware" }, signed with "123".
  const SPEC_TOKEN =
    "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJzZXJ2aWNlIjoibWlkZGxld2FyZSJ9." +
    "VKb-yT2Zz2e4j7R5ssXzU0Mj5MrQ7yxP1H1YRPFmlVANhOYwadSk-5GepYUBz19KASD0QjwLTWtOKLR63Y_R9g";

  it("accepts the spec's own example token with the spec's secret", () => {
    const v = verifyTalabatJwt(`Bearer ${SPEC_TOKEN}`, "123");
    expect(v).toEqual({ ok: true, claims: { service: "middleware" } });
  });

  it("rejects it under any other secret", () => {
    expect(verifyTalabatJwt(`Bearer ${SPEC_TOKEN}`, "1234")).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("requires the service: middleware claim", () => {
    const t = signTalabatJwt({ service: "something-else" }, "s3cret");
    expect(verifyTalabatJwt(`Bearer ${t}`, "s3cret")).toEqual({ ok: false, reason: "wrong_service" });
  });

  it("refuses alg none, missing headers, and an unset secret", () => {
    const none =
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url") +
      "." +
      Buffer.from(JSON.stringify({ service: "middleware" })).toString("base64url") +
      ".x";
    expect(verifyTalabatJwt(`Bearer ${none}`, "s3cret").ok).toBe(false);
    expect(verifyTalabatJwt(undefined, "s3cret")).toEqual({ ok: false, reason: "missing" });
    expect(verifyTalabatJwt(`Bearer ${SPEC_TOKEN}`, "")).toEqual({ ok: false, reason: "no_secret" });
  });

  it("honours exp when present", () => {
    const t = signTalabatJwt({ service: "middleware", exp: 1000 }, "s3cret");
    expect(verifyTalabatJwt(t, "s3cret", 2_000_000)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("Talabat order type (their decision procedure)", () => {
  it("pickup / own delivery / vendor delivery", () => {
    expect(talabatOrderKind({ expeditionType: "pickup", delivery: null })).toBe("PICKUP");
    expect(talabatOrderKind({ expeditionType: "delivery", delivery: { riderPickupTime: "2026-01-01T10:00:00Z" } })).toBe("OWN_DELIVERY");
    expect(talabatOrderKind({ expeditionType: "delivery", delivery: { riderPickupTime: null } })).toBe("VENDOR_DELIVERY");
  });
});

describe("transformTalabatOrder — spec examples", () => {
  it("generic example: pickup, nested topping flattened, test=false, paid", () => {
    const { canonical } = transformTalabatOrder(GENERIC_ORDER_EXAMPLE, { remoteId: "OH-1", country: "AE" });
    expect(canonical.externalId).toBe(GENERIC_ORDER_EXAMPLE.token);
    expect(canonical.platform).toBe("TALABAT");
    expect(canonical.fulfillmentType).toBe("PICKUP");
    expect(canonical.displayId).toBe("TB-42");
    expect(canonical.items).toHaveLength(1);
    const line = canonical.items[0]!;
    // quantity: "string" in their example — junk becomes 1, never NaN.
    expect(line.quantity).toBe(1);
    expect(line.totalPrice).toBe(8);
    expect(line.sku).toBe("ID_FOR_DOUBLE_CHEESE_BURGER_ON_POS");
    expect(line.notes).toBe("No cheese please");
    expect(line.modifiers).toEqual([{ name: "extra cheese", price: 1.5, quantity: 1, depth: 0 }]);
    expect(canonical.total).toBe(25.5);
    expect(canonical.deliveryFee).toBe(2.5); // only the itemised list is given
    expect((canonical.metadata as any).paymentStatus).toBe("PAID");
    expect((canonical.metadata as any).talabat.test).toBe(false);
    expect(canonical.specialInstructions).toContain("Please hurry");
  });

  it("item-level discount example: vendor delivery with address, discounts by sponsor", () => {
    const { canonical } = transformTalabatOrder(ITEM_LEVEL_DISCOUNT_EXAMPLE, { remoteId: "OH-1" });
    expect(canonical.fulfillmentType).toBe("DELIVERY");
    expect((canonical.metadata as any).deliveryType).toBe("MERCHANT");
    expect(canonical.deliveryAddress?.line1).toContain("Oranienburger Str.");
    expect(canonical.deliveryAddress?.coordinates).toEqual({ lat: 50.0710387, lng: 14.4650663 });
    expect(canonical.items[0]!.quantity).toBe(4);
    expect(canonical.items[0]!.unitPrice).toBe(2.5);
    // Top-level discounts: 4.50 + 1.00 + 1.00. Item-level ones are INCLUDED
    // in these and must not be added again.
    expect(canonical.discount).toBe(6.5);
    const promo = (canonical.metadata as any).talabat.promotions;
    expect(promo.platformFunded).toBe(2.5);
    expect(promo.vendorFunded).toBe(2.5);
    expect(promo.thirdPartyFunded).toBe(1.5);
    expect(promo.itemLevel.map((d: any) => d.target)).toEqual([
      "Cheese Burger",
      "Cheese Burger",
      "Cheese Burger › extra cheese",
    ]);
    // Unpaid ("pending") → cash to collect is on the ticket.
    expect((canonical.metadata as any).paymentStatus).toBe("PENDING");
    // Never CARD + PENDING: ingest would hide that as an unpaid Stripe order.
    expect((canonical.metadata as any).paymentMethod).toBe("CASH");
    expect((canonical.metadata as any).talabat.paymentType).toBe("credit-card");
  });

  it("own delivery: no address, PLATFORM courier, callback urls kept", () => {
    const order = {
      ...ITEM_LEVEL_DISCOUNT_EXAMPLE,
      delivery: { ...ITEM_LEVEL_DISCOUNT_EXAMPLE.delivery, riderPickupTime: "2026-10-02T12:00:00.000Z", address: null },
      callbackUrls: { orderAcceptedUrl: "https://integration-middleware.stg.restaurant-partners.com/v2/order/status/x" },
    };
    const { canonical } = transformTalabatOrder(order, { remoteId: "OH-1" });
    expect(canonical.fulfillmentType).toBe("PLATFORM_COURIER");
    expect(canonical.deliveryAddress).toBeUndefined();
    expect((canonical.metadata as any).deliveryType).toBe("PLATFORM");
    expect((canonical.metadata as any).talabat.callbackUrls.orderAcceptedUrl).toContain("/v2/order/status/x");
  });

  it("a test order says so on the ticket", () => {
    const { canonical } = transformTalabatOrder({ ...GENERIC_ORDER_EXAMPLE, test: true }, { remoteId: "OH-1" });
    expect(canonical.specialInstructions).toMatch(/TEST ORDER — DO NOT PREPARE/);
  });

  it("nested toppings carry their depth", () => {
    const order = {
      ...GENERIC_ORDER_EXAMPLE,
      products: [
        {
          name: "Coffee",
          paidPrice: "26.00",
          quantity: "1",
          remoteCode: "COFFEE",
          selectedToppings: [
            {
              name: "Venti",
              price: "3",
              quantity: 1,
              remoteCode: "SIZE_VENTI",
              children: [{ name: "Extra shot", price: "6", quantity: 1, remoteCode: "SHOT", children: [] }],
            },
          ],
        },
      ],
    };
    const { canonical } = transformTalabatOrder(order, { remoteId: "OH-1" });
    expect(canonical.items[0]!.modifiers).toEqual([
      { name: "Venti", price: 3, quantity: 1, depth: 0 },
      { name: "Extra shot", price: 6, quantity: 1, depth: 1 },
    ]);
  });
});

describe("Talabat promotions roll-up", () => {
  it("sums by promotion name and counts each order once per promotion", () => {
    const a = summarizeTalabatDiscounts(ITEM_LEVEL_DISCOUNT_EXAMPLE);
    const b = summarizeTalabatDiscounts(GENERIC_ORDER_EXAMPLE);
    const { rows, totals } = rollUpPromotions([a, b, a]);
    const first = rows.find((r) => r.name === "First Order")!;
    expect(first.orders).toBe(3);
    expect(first.amount).toBe(4.5 * 2 + 9);
    expect(first.vendor).toBe(1.5 * 2 + 3);
    expect(totals.amount).toBe(6.5 * 2 + 9);
  });

  it("an unattributed remainder is reported, not lost", () => {
    const s = summarizeTalabatDiscounts({
      discounts: [{ name: "X", amount: "10", sponsorships: [{ sponsor: "VENDOR", amount: "4" }] }],
    });
    expect(s.unattributed).toBe(6);
  });
});

describe("Talabat outbound rules", () => {
  it("maps free text onto their reject enum, never outside it", () => {
    const all = new Set<string>(TALABAT_REJECT_REASONS);
    for (const text of ["sold out of chicken", "we are closed", "", "no driver", "kitchen slammed", "??", "printer down"]) {
      expect(all.has(talabatRejectReason(text))).toBe(true);
    }
    expect(talabatRejectReason("sold out of chicken")).toBe("ITEM_UNAVAILABLE");
    expect(talabatRejectReason("we are closed")).toBe("CLOSED");
    expect(talabatRejectReason("")).toBe("TOO_BUSY");
    expect(talabatRejectReason("anything", { test: true })).toBe("TEST_ORDER");
    expect(talabatRejectReason("ITEM_UNAVAILABLE")).toBe("ITEM_UNAVAILABLE");
  });

  it("the after-acceptance set is a subset of the enum", () => {
    for (const r of TALABAT_AFTER_ACCEPT_REASONS) expect((TALABAT_REJECT_REASONS as readonly string[]).includes(r)).toBe(true);
    expect(TALABAT_AFTER_ACCEPT_REASONS.has("TOO_BUSY")).toBe(false);
  });

  it("acceptanceTime follows the order type and never lands inside their 2-minute floor", () => {
    const now = Date.parse("2026-10-02T12:00:00.000Z");
    expect(
      talabatAcceptanceTime({ kind: "OWN_DELIVERY", riderPickupTime: "2026-10-02T12:20:00.000Z" }, { now }),
    ).toBe("2026-10-02T12:20:00.000Z");
    // A rider time already past (slow accept) is lifted to now + 3 min.
    expect(
      talabatAcceptanceTime({ kind: "OWN_DELIVERY", riderPickupTime: "2026-10-02T11:50:00.000Z" }, { now }),
    ).toBe("2026-10-02T12:03:00.000Z");
    expect(talabatAcceptanceTime({ kind: "PICKUP" }, { now, prepMinutes: 15 })).toBe("2026-10-02T12:15:00.000Z");
    expect(talabatAcceptanceTime({ kind: "VENDOR_DELIVERY" }, { now, prepMinutes: 15, deliveryMinutes: 30 })).toBe(
      "2026-10-02T12:45:00.000Z",
    );
  });
});
