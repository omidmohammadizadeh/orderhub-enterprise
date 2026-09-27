import { keetaMoney, transformKeetaOrder, type KeetaOrderInfo } from "../keeta-order.transformer";

// Built from the per-field examples in Keeta's Standard order OpenAPI bundle
// (they publish no whole order). metadata.keetaRaw is kept on every real
// order so the first live one can be diffed against this shape.

const order = (over: Partial<KeetaOrderInfo> = {}): KeetaOrderInfo => ({
  baseOrder: {
    orderViewId: 756823555555859,
    chooseTableware: 1,
    ctime: 1751442900803,
    payType: "applepay",
    payTypeDesc: "Apple Pay",
  },
  merchantOrder: {
    seqNoStr: "29332222",
    status: 10,
    orderViewId: 756823555555859,
    shopId: 611469,
    shopName: "Adani Bar",
    userGetMode: "delivery",
  },
  merchantOrderDeliveries: [{ deliveryMode: "1001", deliveryStatus: 0 }],
  recipientInfo: {
    name: "ENC_abc",
    phone: "ENC_def",
    interCode: "+971",
  },
  feeDtl: {
    customerFee: {
      i18n: { currency: "SAR" },
      productPrice: 4600,
      shippingFee: 1900,
      platformFee: 200,
      discounts: 1900,
      tip: 500,
      diffPrice: 0,
      payTotal: 5300,
    },
    merchantFee: null,
  },
  products: [
    {
      spuId: 41669804,
      skuId: 41009754,
      count: 2,
      price: 2300,
      name: "ULTIMATE-TUNA",
      nameI18n: { en: "Ultimate Tuna" },
      currency: "SAR",
      spec: "Large",
      specI18n: { default: "Large" },
      spuOpenItemCode: "item-1",
      skuOpenItemCode: "item-1__s1",
      remark: "extra spicy",
      priceWithGroup: { amount: 4600, unitPrice: 2300 },
      priceWithoutGroup: { amount: 4000, unitPrice: 2000 },
      groups: [
        {
          groupId: 4587525,
          groupName: "Extras",
          shopProductGroupSkuList: [
            {
              groupSkuId: 25703896,
              spuName: "Cheese",
              spuNameI18n: { en: "Cheese" },
              price: 300,
              currency: "SAR",
              count: 1,
              groupSkuCount: 2,
              groups: [
                {
                  groupId: 1,
                  groupName: "Cheese type",
                  shopProductGroupSkuList: [
                    { groupSkuId: 2, spuName: "Cheddar", spuNameI18n: {}, price: 0, currency: "SAR", count: 1, groupSkuCount: 2 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  bigOrderTag: false,
  ...over,
});

describe("transformKeetaOrder", () => {
  it("converts minor units by the currency's exponent", () => {
    const o = transformKeetaOrder(order());
    expect(o.subtotal).toBe(46);
    expect(o.deliveryFee).toBe(19);
    expect(o.discount).toBe(19);
  });

  it("takes the rider's tip OUT of our total and never records it as the shop's", () => {
    const o = transformKeetaOrder(order()) as any;
    // payTotal 53.00 includes a 5.00 courier tip.
    expect(o.total).toBe(48);
    expect(o.tipAmount).toBeUndefined();
    expect(o.metadata.courierTip).toBe(5);
  });

  it("carries Keeta's platform fee as a service charge", () => {
    expect(transformKeetaOrder(order()).serviceCharge).toBe(2);
  });

  it("uses three decimals for Kuwaiti dinars", () => {
    expect(keetaMoney(1250, "KWD")).toBe(1.25);
    expect(keetaMoney(4600, "SAR")).toBe(46);
    const o = transformKeetaOrder(
      order({ feeDtl: { customerFee: { i18n: { currency: "KWD" }, productPrice: 3500, payTotal: 3500 } } }),
    );
    expect(o.subtotal).toBe(3.5);
  });

  it("names lines from Keeta, keeps our own codes, and appends the size", () => {
    const [line] = transformKeetaOrder(order()).items;
    expect(line!.name).toBe("Ultimate Tuna (Large)");
    expect(line!.sku).toBe("item-1__s1");
    expect(line!.externalId).toBe("item-1");
    expect(line!.quantity).toBe(2);
    expect(line!.totalPrice).toBe(46);
    expect(line!.unitPrice).toBe(20);
    expect(line!.notes).toBe("extra spicy");
  });

  it("flattens nested option groups with depth", () => {
    const mods = transformKeetaOrder(order()).items[0]!.modifiers;
    expect(mods).toEqual([
      { name: "Cheese", price: 3, quantity: 1, depth: 0 },
      { name: "Cheddar", price: 0, quantity: 1, depth: 1 },
    ]);
  });

  it("never shows ciphertext as a customer's name or phone", () => {
    const o = transformKeetaOrder(order());
    expect(o.customerInfo.name).toBe("Keeta customer");
    expect(o.customerInfo.phone).toBeUndefined();
  });

  it("uses decrypted details where Keeta allowed decryption", () => {
    const plain: Record<string, string> = { ENC_abc: "Pony Ma", ENC_def: "501234567" };
    const o = transformKeetaOrder(order(), { decrypted: { get: (s) => (s ? plain[s] ?? s : undefined) } });
    expect(o.customerInfo).toEqual({ name: "Pony Ma", phone: "+971501234567" });
  });

  it("treats a Keeta-rider order as platform courier with no address", () => {
    const o = transformKeetaOrder(order()) as any;
    expect(o.fulfillmentType).toBe("PLATFORM_COURIER");
    expect(o.metadata.deliveryType).toBe("PLATFORM");
    expect(o.deliveryAddress).toBeUndefined();
  });

  it("treats deliveryMode 9001 as the shop's own delivery, with the address", () => {
    const o = transformKeetaOrder(
      order({
        merchantOrderDeliveries: [{ deliveryMode: "9001" }],
        recipientInfo: {
          name: "Pony",
          phone: "+971501234567",
          interCode: "+971",
          addressName: "Dubai Marina",
          houseNumber: "Tower 5, 302",
          point: { latitude: 25.08, longitude: 55.14 },
          addressStruct: JSON.stringify({ city: "Dubai" }),
        },
      }),
    ) as any;
    expect(o.fulfillmentType).toBe("DELIVERY");
    expect(o.metadata.deliveryType).toBe("MERCHANT");
    expect(o.deliveryAddress).toMatchObject({
      line1: "Tower 5, 302",
      line2: "Dubai Marina",
      city: "Dubai",
      coordinates: { lat: 25.08, lng: 55.14 },
    });
  });

  it("treats pickup as PICKUP with no delivery type", () => {
    const o = transformKeetaOrder(
      order({ merchantOrder: { ...order().merchantOrder, userGetMode: "pickup" } }),
    ) as any;
    expect(o.fulfillmentType).toBe("PICKUP");
    expect(o.metadata.deliveryType).toBeUndefined();
  });

  it("marks cash orders unpaid and card/wallet orders paid", () => {
    expect((transformKeetaOrder(order()).metadata as any).paymentStatus).toBe("PAID");
    const cash = transformKeetaOrder(order({ baseOrder: { ...order().baseOrder, payType: "Cash" } }));
    expect((cash.metadata as any).paymentMethod).toBe("CASH");
    expect((cash.metadata as any).paymentStatus).toBe("PENDING");
  });

  it("uses the customer-facing sequence number and keeps the full id as externalId", () => {
    const o = transformKeetaOrder(order());
    expect(o.displayId).toBe("KT-29332222");
    expect(o.externalId).toBe("756823555555859");
  });

  it("flags a cutlery request", () => {
    expect(transformKeetaOrder(order()).specialInstructions).toContain("Cutlery requested");
  });

  it("pins the order to the connection's brand", () => {
    expect((transformKeetaOrder(order(), { brandId: "brand-1" }) as any).brandId).toBe("brand-1");
  });

  it("reads products from sub-orders when a large order's top-level list is empty", () => {
    const base = order();
    const o = transformKeetaOrder(
      order({ products: [], bigOrderTag: true, subOrderInfoList: [{ products: base.products }] }),
    );
    expect(o.items).toHaveLength(1);
  });

  it("refuses an order with no id", () => {
    expect(() => transformKeetaOrder({ merchantOrder: {}, baseOrder: {} })).toThrow(/orderViewId/);
  });
});
