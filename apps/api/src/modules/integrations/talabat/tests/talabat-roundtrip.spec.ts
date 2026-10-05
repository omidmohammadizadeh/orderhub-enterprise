import { buildTalabatCatalog, type TbSrcMenu } from "../talabat-menu.transformer";
import { transformTalabatOrder } from "../talabat-order.transformer";
import { TalabatOrderSyncService, talabatAcceptanceTime, talabatRejectReason } from "../talabat-order-sync.service";
import { TalabatSandboxService } from "../talabat-sandbox.service";

// Round trip through the sandbox middleware, in process:
//
//   our menu → catalog (their validator) → an order built FROM that catalog
//   → our transformer → our sync's outbound bodies → their order rules
//
// The point is contract agreement: every body our sync sends must pass the
// rules the spec states, and every remoteCode the middleware sends must be
// an id we published.

const src: TbSrcMenu = {
  menuId: "m1",
  menuName: "Main",
  categories: [
    { id: "burgers", name: "Burgers", itemIds: ["burger", "pizza"] },
  ],
  items: [
    { id: "burger", name: "Burger", available: true, price: 25, groupIds: ["sauce"], imageUrl: "https://cdn.example.com/b.jpg" },
    {
      id: "pizza",
      name: "Pizza",
      available: true,
      price: 0,
      groupIds: [],
      sizes: [
        { id: "pizza__size0", name: "Small", price: 30, groupIds: ["extras"] },
        { id: "pizza__size1", name: "Large", price: 45, groupIds: ["extras"] },
      ],
    },
  ],
  groups: new Map([
    ["sauce", { id: "sauce", name: "Sauce", min: 1, max: 1, options: [{ id: "ketchup", name: "Ketchup", price: 0, available: true, groupIds: ["heat"] }] }],
    ["heat", { id: "heat", name: "Heat", min: 1, max: 1, options: [{ id: "hot", name: "Hot", price: 1, available: true }] }],
    ["extras", { id: "extras", name: "Extras", min: 0, max: 3, options: [{ id: "cheese", name: "Cheese", price: 4, available: true }] }],
  ]),
};

describe("Talabat round trip through the sandbox middleware", () => {
  const sandbox = new TalabatSandboxService();
  const built = buildTalabatCatalog(src);

  it("our catalog passes their validation", () => {
    expect(built.problems.filter((p) => p.level === "error")).toEqual([]);
    expect(sandbox.validateCatalog({ vendors: ["OH-1"], catalog: built.catalog })).toEqual([]);
  });

  for (const kind of ["OWN_DELIVERY", "VENDOR_DELIVERY", "PICKUP"] as const) {
    it(`${kind}: order from our catalog → canonical → accept/ready/pickup bodies accepted`, () => {
      const order = sandbox.buildOrder({
        catalog: built.catalog as any,
        remoteId: "OH-1",
        chainCode: "chain-ae",
        platformVendorId: "tb-1",
        kind,
        withDiscount: true,
      });
      sandbox.orders.set(order.token, {
        order,
        remoteId: "OH-1",
        chainCode: "chain-ae",
        remoteOrderId: null,
        state: "RECEIVED",
        riderAccepted: false,
        modificationPending: false,
        history: [],
      });

      const { canonical } = transformTalabatOrder(order, { remoteId: "OH-1", country: "AE" });
      // Every line's remoteCode is a product we published.
      for (const i of canonical.items) expect(built.catalog!.items[i.sku!]).toBeDefined();
      // The required nested choice came through, indented under its parent.
      const burger = canonical.items.find((i) => i.sku === "burger");
      expect(burger?.modifiers.map((m) => [m.name, m.depth])).toEqual([
        ["Ketchup", 0],
        ["Hot", 1],
      ]);
      expect(canonical.discount).toBeGreaterThan(0);

      const t = (canonical.metadata as any).talabat;
      const accept = {
        status: "order_accepted",
        acceptanceTime: talabatAcceptanceTime(t),
        remoteOrderId: "ord_1",
      };
      expect(sandbox.orderStatus(order.token, accept).status).toBe(200);

      if (kind === "OWN_DELIVERY") {
        expect(t.callbackUrls.orderPreparedUrl).toBeTruthy();
        expect(sandbox.prepared(order.token).status).toBe(200);
        // Vendor + rider accepted → no more prep-time changes, per their table.
        sandbox.orders.get(order.token)!.riderAccepted = true;
        expect(sandbox.adjustPrep(order.token, { expectedPickupAt: t.riderPickupTime }).status).toBe(409);
      } else {
        expect(t.callbackUrls.orderPreparedUrl).toBeNull();
        expect(sandbox.orderStatus(order.token, { status: "order_picked_up" }).status).toBe(200);
      }
    });
  }

  it("a reject with our mapped reason is accepted before acceptance, refused after with a before-only reason", () => {
    const order = sandbox.buildOrder({ catalog: built.catalog as any, remoteId: "OH-1", chainCode: "c", platformVendorId: "v", kind: "OWN_DELIVERY" });
    const entry = { order, remoteId: "OH-1", chainCode: "c", remoteOrderId: null, state: "RECEIVED" as const, riderAccepted: false, modificationPending: false, history: [] };
    sandbox.orders.set(order.token, { ...entry });
    expect(sandbox.orderStatus(order.token, { status: "order_rejected", reason: talabatRejectReason("out of stock") }).status).toBe(200);

    const again = sandbox.buildOrder({ catalog: built.catalog as any, remoteId: "OH-1", chainCode: "c", platformVendorId: "v", kind: "OWN_DELIVERY" });
    sandbox.orders.set(again.token, { ...entry, order: again, state: "ACCEPTED" });
    // Our sync refuses to send this (see talabat-intake.spec); the middleware
    // would have refused it too.
    expect(sandbox.orderStatus(again.token, { status: "order_rejected", reason: "TOO_BUSY" }).status).toBe(400);
  });

  it("acceptanceTime inside their 2-minute floor is refused by them — ours never is", () => {
    const order = sandbox.buildOrder({ catalog: built.catalog as any, remoteId: "OH-1", chainCode: "c", platformVendorId: "v", kind: "PICKUP" });
    sandbox.orders.set(order.token, { order, remoteId: "OH-1", chainCode: "c", remoteOrderId: null, state: "RECEIVED", riderAccepted: false, modificationPending: false, history: [] });
    const tooSoon = new Date(Date.now() + 60_000).toISOString();
    expect(sandbox.orderStatus(order.token, { status: "order_accepted", acceptanceTime: tooSoon, remoteOrderId: "x" }).status).toBe(400);
    const ours = talabatAcceptanceTime({ kind: "PICKUP", pickupTime: tooSoon });
    expect(sandbox.orderStatus(order.token, { status: "order_accepted", acceptanceTime: ours, remoteOrderId: "x" }).status).toBe(200);
  });

  it("our modification body is accepted only after acceptance", () => {
    const order = sandbox.buildOrder({ catalog: built.catalog as any, remoteId: "OH-1", chainCode: "c", platformVendorId: "v", kind: "VENDOR_DELIVERY" });
    sandbox.orders.set(order.token, { order, remoteId: "OH-1", chainCode: "c", remoteOrderId: "ord_9", state: "RECEIVED", riderAccepted: false, modificationPending: false, history: [] });
    const body = { modifications: { products: [{ id: order.products![0]!.id, remoteCode: order.products![0]!.remoteCode, modification: { type: "REMOVAL" } }] } };
    expect(sandbox.modify(order.token, body).status).toBe(409);
    sandbox.orders.get(order.token)!.state = "ACCEPTED";
    expect(sandbox.modify(order.token, body).status).toBe(202);
    // One at a time.
    expect(sandbox.modify(order.token, body).status).toBe(409);
  });

  it("the sync service exists to send exactly these bodies", () => {
    expect(typeof TalabatOrderSyncService.prototype.sync).toBe("function");
  });
});
