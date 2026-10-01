import { GroupOrdersService } from "../group-orders.service";

// A group basket used to be placed from each guest's stored lineTotal and the
// host's own deliveryFee — both sent by the browser. It now goes through the
// storefront checkout, which prices, zones and gates it like any online order.

function setup(basketOver: Record<string, any> = {}) {
  const basket = {
    id: "b1",
    token: "tok",
    status: "LOCKED",
    hostRef: "host",
    locationId: "loc1",
    tenantId: "t1",
    brandId: "brand1",
    fulfillmentType: "DELIVERY",
    ...basketOver,
  };
  const items = [
    {
      addedByName: "Sam",
      addedByRef: "host",
      quantity: 1,
      lineTotal: 0.01, // tampered: the checkout must be the one pricing it
      cartItem: {
        name: "Margherita",
        unitPrice: 0.01,
        menuItemId: "pizza",
        skuPlu: "PZ-12",
        skuName: '12"',
        modifiers: [{ name: "Ham", price: 0, optionId: "ham" }],
      },
    },
    {
      addedByName: "Alex",
      addedByRef: "guest",
      quantity: 2,
      lineTotal: 3,
      cartItem: { name: "Cola", unitPrice: 1.5, menuItemId: "cola", modifiers: [] },
    },
  ];
  const updates: any[] = [];
  const db = {
    groupOrder: {
      findUnique: jest.fn(async () => basket),
      update: jest.fn(async (a: any) => updates.push(a)),
    },
    groupOrderItem: { findMany: jest.fn(async () => items) },
    order: { findUnique: jest.fn(async () => ({ id: "existing" })) },
    location: {
      findFirst: jest.fn(async () => ({
        id: "loc1",
        slug: null,
        onlineOrderingSlug: "pizza-place",
        isActive: true,
        deletedAt: null,
        brandId: "brand1",
        brand: { tenantId: "t1" },
      })),
    },
  };
  const ordering = { checkout: jest.fn(async () => ({ id: "order1", checkoutUrl: "https://pay" })) };
  const svc = new GroupOrdersService(db as any, {} as any, {} as any, ordering as any);
  return { svc, ordering, updates, db };
}

const address = { line1: "1 High St", city: "Leeds", postcode: "LS1 1AA" };

describe("GroupOrdersService.place", () => {
  it("places the basket through the storefront checkout, priced there", async () => {
    const { svc, ordering, updates } = setup();
    const res = await svc.place("tok", {
      hostRef: "host",
      customerInfo: { name: "Sam" },
      deliveryAddress: address,
      deliveryFee: 0, // a tampered fee is only a starting point for the checkout
      paymentMethod: "card",
    });
    expect(res).toMatchObject({ id: "order1", checkoutUrl: "https://pay" });
    const [slug, dto, brand] = (ordering.checkout as jest.Mock).mock.calls[0];
    expect(slug).toBe("pizza-place");
    expect(brand).toBe("brand1");
    expect(dto).toMatchObject({
      fulfillmentType: "DELIVERY",
      paymentMethod: "CARD",
      idempotencyKey: "group-tok",
      deliveryAddress: address,
    });
    expect(dto.items).toEqual([
      expect.objectContaining({
        menuItemId: "pizza",
        name: "Margherita (Sam)",
        skuPlu: "PZ-12",
        modifiers: [expect.objectContaining({ optionId: "ham" })],
      }),
      expect.objectContaining({ menuItemId: "cola", name: "Cola (Alex)", quantity: 2 }),
    ]);
    expect(dto.specialInstructions).toMatch(/GROUP ORDER — 2 item\(s\) from 2 people/);
    expect(updates[0]).toMatchObject({ data: { status: "PLACED", orderId: "order1" } });
  });

  it("leaves the basket open when the checkout refuses it", async () => {
    const { svc, ordering, updates } = setup();
    (ordering.checkout as jest.Mock).mockRejectedValueOnce(new Error("Your basket needs a refresh"));
    await expect(
      svc.place("tok", { hostRef: "host", customerInfo: { name: "Sam" }, deliveryAddress: address }),
    ).rejects.toThrow(/refresh/);
    expect(updates).toHaveLength(0);
  });

  it("only the host may place it", async () => {
    const { svc, ordering } = setup();
    await expect(
      svc.place("tok", { hostRef: "guest", customerInfo: { name: "Alex" }, deliveryAddress: address }),
    ).rejects.toThrow(/started this group order/);
    expect(ordering.checkout).not.toHaveBeenCalled();
  });

  it("a second tap returns the order already placed", async () => {
    const { svc, ordering } = setup({ status: "PLACED", orderId: "existing" });
    await expect(svc.place("tok", { hostRef: "host", customerInfo: { name: "Sam" } })).resolves.toMatchObject({
      id: "existing",
    });
    expect(ordering.checkout).not.toHaveBeenCalled();
  });
});
