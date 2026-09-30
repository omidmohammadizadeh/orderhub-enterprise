import { OrdersService } from "../orders.service";
import { resolveDeliveryAddress } from "../delivery-address";

// A customer rings back to say they're at their mum's tonight.
//
// editOrder wrote the `deliveryAddress` blob and nothing else, while
// createOrder and switchFulfillment both maintain the structured columns
// beside it. Dispatch prices a driver's fee straight off order.postcode
// (driver-earnings.service.ts, dispatch.service.ts), so the ticket read
// correctly and the money was worked out from the previous house.

const service = () => {
  const s: any = Object.create(OrdersService.prototype);
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  s.socket = { emitNewOrder: jest.fn(), emitOrderUpdated: jest.fn() };
  s.events = { emit: jest.fn() };
  return s;
};

const existing = (over: any = {}) => ({
  id: "o1",
  tenantId: "t1",
  locationId: "l1",
  status: "PREPARING",
  paymentMethod: "CASH",
  paymentStatus: "PENDING",
  orderSource: "POS",
  platform: "POS",
  fulfillmentType: "DELIVERY",
  total: 25,
  customerInfo: null,
  customerName: "Omid",
  customerPhone: "+447700900123",
  deliveryAddress: { line1: "1 Old Street", city: "London", postcode: "N1 6AH" },
  addressLine1: "1 Old Street",
  addressLine2: null,
  city: "London",
  postcode: "N1 6AH",
  deliveryLat: 51.52,
  deliveryLng: -0.09,
  specialInstructions: null,
  scheduledFor: null,
  createdAt: new Date(),
  items: [
    {
      id: "row-1",
      name: "Pizza",
      quantity: 1,
      unitPrice: 25,
      totalPrice: 25,
      modifiers: [],
      notes: null,
      menuItemId: "p1",
    },
  ],
  ...over,
});

const prismaWith = (order: any) => {
  const tx = {
    orderItem: {
      update: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({})),
      createMany: jest.fn(async () => ({})),
    },
    order: { update: jest.fn(async () => ({ ...order, items: undefined })) },
    orderStatusHistory: { create: jest.fn(async () => ({})) },
  };
  return {
    tx,
    prisma: {
      order: { findFirst: jest.fn(async () => order) },
      $transaction: async (fn: any) => fn(tx),
    },
  };
};

const sameItems = [
  {
    name: "Pizza",
    quantity: 1,
    unitPrice: 25,
    totalPrice: 25,
    modifiers: [],
    menuItemId: "p1",
  },
];

const NEW_ADDRESS = {
  line1: "42 New Road",
  line2: "Flat 3",
  city: "Manchester",
  postcode: "M1 4EU",
};

async function edit(order: any, dto: any) {
  const s = service();
  const { prisma, tx } = prismaWith(order);
  s.prisma = prisma;
  await s.editOrder(
    "o1",
    "t1",
    { items: sameItems, subtotal: 25, total: 25, ...dto },
    "user-1",
  );
  return tx.order.update.mock.calls[0][0].data;
}

describe("editOrder: changing where the order is going", () => {
  it("writes the structured columns, not just the blob", async () => {
    const data = await edit(existing(), { deliveryAddress: NEW_ADDRESS });
    expect(data.deliveryAddress).toEqual(NEW_ADDRESS);
    expect(data.addressLine1).toBe("42 New Road");
    expect(data.addressLine2).toBe("Flat 3");
    expect(data.city).toBe("Manchester");
    // The one dispatch actually prices off.
    expect(data.postcode).toBe("M1 4EU");
  });

  it("drops coordinates that belong to the old address", async () => {
    // Otherwise the driver reads the right address and drives to the pin at
    // the previous door.
    const data = await edit(existing(), { deliveryAddress: NEW_ADDRESS });
    expect(data.deliveryLat).toBeNull();
    expect(data.deliveryLng).toBeNull();
    expect(data.geocodedAt).toBeNull();
  });

  it("clears a column the new address doesn't fill", async () => {
    // Moving from "Flat 3, 42 New Road" to a house must not leave the flat
    // number on the ticket.
    const data = await edit(
      existing({ addressLine2: "Flat 3" }),
      { deliveryAddress: { line1: "9 Hill Rd", city: "Leeds", postcode: "LS1 1AA" } },
    );
    expect(data.addressLine2).toBeNull();
  });

  it("leaves the address alone when the edit isn't about the address", async () => {
    // A collection order, or adding a drink to a delivery: the POS sends no
    // deliveryAddress at all, and an untouched address must stay untouched —
    // including its coordinates, which are expensive to get back.
    const data = await edit(existing(), {});
    expect(data).not.toHaveProperty("deliveryAddress");
    expect(data).not.toHaveProperty("addressLine1");
    expect(data).not.toHaveProperty("postcode");
    expect(data).not.toHaveProperty("deliveryLat");
  });

  it("keeps the blob and the columns saying the same thing", async () => {
    // The two are read by different code paths; the whole point of writing
    // both is that neither can answer differently afterwards.
    const data = await edit(existing(), { deliveryAddress: NEW_ADDRESS });
    expect(resolveDeliveryAddress(data as any)).toMatchObject({
      line1: "42 New Road",
      city: "Manchester",
      postcode: "M1 4EU",
    });
    expect(
      resolveDeliveryAddress({
        addressLine1: data.addressLine1,
        addressLine2: data.addressLine2,
        city: data.city,
        postcode: data.postcode,
      } as any),
    ).toMatchObject({
      line1: "42 New Road",
      city: "Manchester",
      postcode: "M1 4EU",
    });
  });

  it("carries the delivery area through, for shops that price by area", async () => {
    const data = await edit(existing(), {
      deliveryAddress: {
        line1: "Villa 7",
        city: "Dubai",
        postcode: "",
        area: "Jumeirah",
      },
    });
    expect((data.deliveryAddress as any).area).toBe("Jumeirah");
    expect(resolveDeliveryAddress(data as any).area).toBe("Jumeirah");
  });
});
