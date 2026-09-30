import { WhatsAppAiService } from "../whatsapp-ai.service";
import { emptyCart } from "../whatsapp-cart";

// Challenge 25 on WhatsApp: a restricted basket gets a Yes/No button before
// payment, nothing is placed without the answer, and the order carries the
// ID CHECK note and the age record.

const ctx = () =>
  ({
    itemIndex: new Map<string, any>([
      ["wine", { id: "wine", name: "Echo Falls Rosé", price: 6.5, minAge: 18, modifierGroups: [] }],
      ["energy", { id: "energy", name: "Red Bull", price: 1.85, minAge: 16, modifierGroups: [] }],
      ["bread", { id: "bread", name: "Hovis", price: 1.65, minAge: null, modifierGroups: [] }],
    ]),
  }) as any;

const line = (itemId: string, name: string, price: number) => ({
  lineId: itemId,
  itemId,
  name,
  quantity: 1,
  unitBasePrice: price,
  modifiers: [],
});

const make = () => {
  const svc = Object.create(WhatsAppAiService.prototype) as any;
  const buttons: any[] = [];
  svc.send = { sendButtons: jest.fn(async (...a: any[]) => buttons.push(a)) };
  return { svc, buttons };
};

describe("WhatsApp age check", () => {
  it("asks once with Yes / No buttons for the highest age in the basket", async () => {
    const { svc, buttons } = make();
    const cart = { ...emptyCart(), items: [line("energy", "Red Bull", 1.85), line("wine", "Echo Falls Rosé", 6.5)] };
    expect(await svc.askAgeIfNeeded("pn", "447700900123", cart, ctx())).toBe(true);
    expect(buttons[0][2]).toMatch(/18 or over/);
    expect(buttons[0][3].map((b: any) => b.id)).toEqual(["age:yes", "age:no"]);

    cart.ageConfirmed = 18;
    expect(await svc.askAgeIfNeeded("pn", "447700900123", cart, ctx())).toBe(false);
  });

  it("a 16+ answer doesn't cover an 18+ item added afterwards", async () => {
    const { svc } = make();
    const cart = { ...emptyCart(), items: [line("energy", "Red Bull", 1.85)], ageConfirmed: 16 };
    expect(await svc.askAgeIfNeeded("pn", "447700900123", cart, ctx())).toBe(false);
    cart.items.push(line("wine", "Echo Falls Rosé", 6.5));
    expect(await svc.askAgeIfNeeded("pn", "447700900123", cart, ctx())).toBe(true);
  });

  it("never asks for an ordinary basket", async () => {
    const { svc, buttons } = make();
    const cart = { ...emptyCart(), items: [line("bread", "Hovis", 1.65)] };
    expect(await svc.askAgeIfNeeded("pn", "447700900123", cart, ctx())).toBe(false);
    expect(buttons).toHaveLength(0);
  });

  it("stamps the order with the ID CHECK note and the age record", () => {
    const { svc } = make();
    const cart = { ...emptyCart(), fulfillmentType: "PICKUP" as const, items: [line("wine", "Echo Falls Rosé", 6.5)] };
    const order = svc.cartToCanonical(cart, "447700900123", "Sam", 0, "pn", 0, "CASH", svc.cartMinAge(cart, ctx()));
    expect(order.specialInstructions).toMatch(/^ID CHECK 18\+ — Challenge 25/);
    expect(order.metadata.ageCheck).toMatchObject({ minAge: 18, method: "CUSTOMER_CONFIRMED" });

    const plain = svc.cartToCanonical({ ...cart, items: [line("bread", "Hovis", 1.65)] }, "447700900123", "Sam", 0, "pn");
    expect(plain.specialInstructions).toBeUndefined();
    expect(plain.metadata.ageCheck).toBeUndefined();
  });
});
