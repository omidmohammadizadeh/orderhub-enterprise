import { WebhookIngestionService } from "../webhook-ingestion.service";

// HubRise order webhooks arrive as an event envelope with only an order id
// (no line items), so the adapter would drop them. enrichHubRiseOrderPayload
// fetches the full order and merges it in — this is what makes the
// per-location webhook URL we register actually ingest HubRise orders.

function makeService(fetchImpl: jest.Mock) {
  (globalThis as any).fetch = fetchImpl;
  const encryption = {
    decrypt: () => ({ accessToken: "ohr_tok" }),
  } as any;
  return new WebhookIngestionService(
    {} as any, // prisma
    {} as any, // orders
    {} as any, // adapterFactory
    encryption,
  );
}

const call = (svc: any, payload: any) =>
  svc.enrichHubRiseOrderPayload(payload, { enc: true }, "hloc1");

describe("WebhookIngestionService.enrichHubRiseOrderPayload", () => {
  it("fetches the full order and merges items when the envelope has none", async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "ord-1", items: [{ product_name: "Pizza" }] }),
    }));
    const svc = makeService(fetchMock);
    const out: any = await call(svc, {
      id: "evt-9",
      resource_type: "order",
      event_type: "create",
      order_id: "ord-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/locations/hloc1/orders/ord-1");
    expect(Array.isArray(out.items)).toBe(true);
    expect(out.items).toHaveLength(1);
    // event id preserved for idempotency
    expect(out.event_id).toBe("evt-9");
    expect(out.order_id).toBe("ord-1");
  });

  it("accepts resource_id as the order id (tolerant field matching)", async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "ord-2", items: [] }),
    }));
    const svc = makeService(fetchMock);
    await call(svc, { id: "evt", resource_type: "order", resource_id: "ord-2" });
    expect(fetchMock.mock.calls[0][0]).toContain("/orders/ord-2");
  });

  it("leaves a payload that already has items untouched (no fetch)", async () => {
    const fetchMock = jest.fn();
    const svc = makeService(fetchMock);
    const full = { id: "ord-3", items: [{ x: 1 }] };
    const out = await call(svc, full);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toBe(full);
  });

  it("leaves a non-order envelope untouched (no order id)", async () => {
    const fetchMock = jest.fn();
    const svc = makeService(fetchMock);
    const out = await call(svc, { id: "evt", resource_type: "catalog", event_type: "update" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toEqual({ id: "evt", resource_type: "catalog", event_type: "update" });
  });

  it("throws (→ HubRise retries) when the order fetch fails", async () => {
    const fetchMock = jest.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "token revoked",
    }));
    const svc = makeService(fetchMock);
    await expect(
      call(svc, { id: "evt", order_id: "ord-4" }),
    ).rejects.toThrow(/HubRise order fetch 401/);
  });
});
