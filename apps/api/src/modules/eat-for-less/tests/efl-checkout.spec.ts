import { EflService } from "../efl.service";

// The app is a client we don't control. Whatever it sends, an Eat For Less
// order is card-paid, filed under the signed-in customer with the phone they
// proved, and never subscribes them to the shop's own marketing.

const LIVE_LISTING = {
  id: "lst_1",
  listed: true,
  status: "APPROVED",
  hiddenReason: null,
  brandId: null,
  commissionPercent: null,
  acceptsDelivery: true,
  acceptsCollection: true,
  location: {
    id: "loc_1",
    isActive: true,
    deletedAt: null,
    onlineOrderingSlug: "pizza-pizza",
    slug: null,
    brandId: "brand_1",
  },
};

function setup(opts: {
  account?: Partial<{ phone: string | null; phoneVerifiedAt: Date | null }>;
  ordersInLastHour?: number;
  earlierPaid?: number;
  orderTotal?: number;
} = {}) {
  const orderUpdate = jest.fn(async () => ({}));
  const counts = [opts.ordersInLastHour ?? 0, opts.earlierPaid ?? 1];
  const prisma: any = {
    eflListing: { findUnique: jest.fn(async () => LIVE_LISTING) },
    eflConfig: { findUnique: jest.fn(async () => null) },
    customerAccount: {
      findUnique: jest.fn(async () => ({
        id: "cust_1",
        firstName: "Sam",
        lastName: "Lee",
        email: "sam@example.com",
        phone: "+447700900482",
        phoneVerifiedAt: new Date(),
        ...opts.account,
      })),
    },
    order: { count: jest.fn(async () => counts.shift()), update: orderUpdate },
  };
  const ordering: any = {
    checkout: jest.fn(async (_slug: string, _dto: any, _brand: any, _app: any, channel: any) => {
      const total = opts.orderTotal ?? 30;
      await channel.beforeCreate({ subtotal: total, discount: 0, total });
      const order = { id: "ord_1", total };
      await channel.afterCreate(order);
      return { ...order, displayId: "AB12C", clientSecret: "pi_secret", stripeAccountId: "acct_1", amountPence: 3000 };
    }),
  };
  const service = new EflService(prisma, ordering, {} as any, {} as any);
  return { service, prisma, ordering, orderUpdate };
}

const body: any = {
  idempotencyKey: "k1",
  fulfillmentType: "DELIVERY",
  customerInfo: { name: "Someone Else", phone: "07000000000", email: "other@example.com" },
  items: [],
  subtotal: 30,
  total: 30,
  paymentMethod: "CASH",
  marketingConsent: true,
  emailMarketingConsent: true,
  emailRecipientId: "er_1",
};

describe("EflService.checkout", () => {
  it("overrides what the app may not decide", async () => {
    const { service, ordering } = setup();
    await service.checkout({ id: "cust_1" }, "lst_1", body);

    const [slug, dto, brandId, appClient, channel] = ordering.checkout.mock.calls[0];
    expect(slug).toBe("pizza-pizza");
    expect(brandId).toBeUndefined();
    expect(appClient).toBeNull();
    expect(dto.paymentMethod).toBe("CARD");
    expect(dto.embedded).toBe(true);
    expect(dto.customerAccountId).toBe("cust_1");
    expect(dto.customerInfo).toEqual({ name: "Sam Lee", phone: "+447700900482", email: "sam@example.com" });
    expect(dto.marketingConsent).toBe(false);
    expect(dto.emailMarketingConsent).toBe(false);
    expect(dto.emailRecipientId).toBeUndefined();
    expect(channel).toMatchObject({
      orderSource: "EAT_FOR_LESS",
      pauseChannel: "EAT_FOR_LESS",
      priceChannel: "EAT_FOR_LESS",
    });
  });

  it("stamps the commission and, for a regular under £25, no PIN", async () => {
    const { service, orderUpdate } = setup({ orderTotal: 20, earlierPaid: 3 });
    const res = await service.checkout({ id: "cust_1" }, "lst_1", body);

    expect(orderUpdate).toHaveBeenCalledWith({
      where: { id: "ord_1" },
      data: { eflCommissionPercent: 8, deliveryPin: null },
    });
    expect(res).toMatchObject({ orderId: "ord_1", clientSecret: "pi_secret", stripeAccountId: "acct_1" });
  });

  it("gives a new customer's delivery a PIN", async () => {
    const { service, orderUpdate } = setup({ orderTotal: 20, earlierPaid: 0 });
    await service.checkout({ id: "cust_1" }, "lst_1", body);
    const data = (orderUpdate.mock.calls[0] as any)[0].data;
    expect(data.deliveryPin).toMatch(/^\d{4}$/);
  });

  it("refuses before checkout when the phone isn't verified", async () => {
    const { service, ordering } = setup({ account: { phoneVerifiedAt: null } });
    await expect(service.checkout({ id: "cust_1" }, "lst_1", body)).rejects.toThrow(/mobile number/);
    expect(ordering.checkout).not.toHaveBeenCalled();
  });

  it("refuses a new customer's oversized first order once it's priced", async () => {
    const { service, orderUpdate } = setup({ orderTotal: 75, earlierPaid: 0 });
    await expect(service.checkout({ id: "cust_1" }, "lst_1", body)).rejects.toThrow(/first order/);
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it("refuses dine-in", async () => {
    const { service } = setup();
    await expect(
      service.checkout({ id: "cust_1" }, "lst_1", { ...body, fulfillmentType: "DINE_IN" }),
    ).rejects.toThrow(/delivery or collection/);
  });
});
