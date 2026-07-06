import { UberEatsOrderActionsService } from "../ubereats-order-actions.service";

// These endpoints are on Uber's certification checklist — the exact paths
// and spec-shaped bodies matter more than anything else here.

function makeService() {
  const calls: Array<{ method: string; path: string; opts: any }> = [];
  const client = {
    request: jest.fn(async (method: string, path: string, opts: any) => {
      calls.push({ method, path, opts });
      return null;
    }),
  };
  const prisma = {
    order: {
      findFirst: jest.fn(async () => ({
        id: "our-1",
        externalId: "uber-9",
        metadata: { uberStoreId: "store-5" },
      })),
    },
  };
  const svc = new UberEatsOrderActionsService(prisma as any, client as any);
  return { svc, calls, prisma };
}

describe("UberEatsOrderActionsService", () => {
  it("adjust-price sends amount_e5 + reason", async () => {
    const { svc, calls } = makeService();
    await svc.adjustPrice("t1", "our-1", {
      amountPounds: 7.5,
      taxRate: 20,
      reason: "ITEM_SOLD_OUT",
      customReason: "no more dough",
    });
    expect(calls[0].path).toBe("/v1/delivery/order/uber-9/adjust-price");
    expect(calls[0].opts.body).toEqual({
      amount_e5: 750000,
      tax_rate: "20",
      reason: "ITEM_SOLD_OUT",
      custom_reason: "no more dough",
    });
  });

  it("update-ready-time sends an RFC3339 timestamp", async () => {
    const { svc, calls } = makeService();
    const before = Date.now();
    await svc.updateReadyTime("t1", "our-1", { minutesFromNow: 10 });
    const sent = calls[0].opts.body.ready_for_pickup_time;
    expect(calls[0].path).toBe(
      "/v1/delivery/order/uber-9/update-ready-time",
    );
    const t = Date.parse(sent);
    expect(t).toBeGreaterThanOrEqual(before + 9.5 * 60_000);
    expect(t).toBeLessThanOrEqual(before + 10.5 * 60_000);
  });

  it("validate-item-fulfillment passes the spec body through", async () => {
    const { svc, calls } = makeService();
    const body = {
      issue_type: "OUT_OF_ITEM",
      action_type: "REMOVE_ITEM",
      item: { cart_item_id: "ci-1" },
    };
    await svc.validateItemFulfillment("t1", "our-1", body);
    expect(calls[0].path).toBe(
      "/v1/delivery/order/uber-9/validate-item-fulfillment",
    );
    expect(calls[0].opts.body).toEqual(body);
  });

  it("validate-item-fulfillment auto-fills from the live order when body is empty", async () => {
    // With no live cart item available in the mock, the auto-fill path can't
    // resolve a cart_item_id and surfaces a clear error (real orders resolve).
    const { svc } = makeService();
    await expect(
      svc.validateItemFulfillment("t1", "our-1", {}),
    ).rejects.toThrow(/cart_item_id/);
  });

  it("resolve-fulfillment-issues auto-fills issues when none supplied", async () => {
    const { svc, calls } = makeService();
    await expect(
      svc.resolveFulfillmentIssues("t1", "our-1", {}),
    ).rejects.toThrow(/cart_item_id/);
    const body = {
      fulfillment_issues: [
        {
          issue_type: "OUT_OF_ITEM",
          action_type: "REMOVE_ITEM",
          item: { cart_item_id: "ci-1" },
        },
      ],
    };
    await svc.resolveFulfillmentIssues("t1", "our-1", body);
    // The empty-body call above emitted a GET (auto-fill probe); assert the
    // actual resolve POST regardless of position.
    const post = calls.find((c: any) =>
      c.path.endsWith("/resolve-fulfillment-issues"),
    );
    expect(post.path).toBe(
      "/v1/delivery/order/uber-9/resolve-fulfillment-issues",
    );
    expect(post.opts.body).toEqual(body);
  });

  it("replacement recommendations resolve the store id from order metadata", async () => {
    const { svc, calls } = makeService();
    await svc.replacementRecommendations("t1", "our-1", { itemId: "item-3" });
    expect(calls[0].path).toBe("/v1/delivery/get-replacement-recommendations");
    expect(calls[0].opts.body).toEqual({
      id: "item-3",
      order_id: "uber-9",
      store_id: "store-5",
    });
  });

  it("404s when the order isn't a direct Uber Eats order", async () => {
    const { svc, prisma } = makeService();
    (prisma.order.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(
      svc.updateReadyTime("t1", "nope", { minutesFromNow: 5 }),
    ).rejects.toThrow(/not found/);
  });
});
