import { ConflictException } from "@nestjs/common";
import { OrdersService } from "../orders.service";

// The POS offline queue re-sends an order with the same idempotencyKey after
// every reconnect, and a till that lost a response re-sends it too. A replay
// must hand back the ORIGINAL order — never a second one, and never a 500.
//
// It used to 500: create() mints a fresh random externalId per call, so the
// P2002 safety net in ingestCanonical looked the existing row up by an id
// nobody had stored, found nothing, and re-threw. The queued order then
// retried for ever and never reached the board.

const ORIGINAL = {
  id: "order-1",
  locationId: "loc-1",
  idempotencyKey: "local:abc",
  status: "ACCEPTED",
};

function makeService(existing: Record<string, unknown> | null) {
  const prisma = {
    location: {
      findFirst: jest.fn(async () => ({ id: "loc-1", country: "GB", settings: {} })),
    },
    order: {
      findFirst: jest.fn(async () => existing),
    },
  } as any;
  const svc = Object.create(OrdersService.prototype) as any;
  svc.prisma = prisma;
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.ingestCanonical = jest.fn(async () => {
    throw new Error("must not ingest a replay");
  });
  return { svc, prisma };
}

const DTO = {
  locationId: "loc-1",
  idempotencyKey: "local:abc",
  orderSource: "POS",
  customerInfo: { name: "Walk-in" },
  items: [{ name: "Margherita", quantity: 1, unitPrice: 9, totalPrice: 9 }],
  subtotal: 9,
  total: 9,
};

describe("OrdersService.create — idempotent replay", () => {
  it("returns the original order for a repeated idempotencyKey", async () => {
    const { svc } = makeService(ORIGINAL);
    const out = await svc.create(DTO, "tenant-1");
    expect(out).toBe(ORIGINAL);
    expect(svc.ingestCanonical).not.toHaveBeenCalled();
  });

  it("refuses a key that belongs to another location's order", async () => {
    const { svc } = makeService({ ...ORIGINAL, locationId: "someone-else" });
    await expect(svc.create(DTO, "tenant-1")).rejects.toBeInstanceOf(ConflictException);
    expect(svc.ingestCanonical).not.toHaveBeenCalled();
  });

  it("creates normally when the key is new", async () => {
    const { svc } = makeService(null);
    await expect(svc.create(DTO, "tenant-1")).rejects.toThrow("must not ingest a replay");
    expect(svc.ingestCanonical).toHaveBeenCalledTimes(1);
  });
});
