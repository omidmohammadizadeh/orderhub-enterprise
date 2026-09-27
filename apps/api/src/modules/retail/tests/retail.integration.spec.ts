// Retail R1 against a real Postgres: the parts that only prove themselves on
// a database — ON CONFLICT dedupe, upserted running totals, the returns
// transaction, the import's matching.
//
// Skipped unless RETAIL_IT_DATABASE_URL points at a DISPOSABLE database with
// every migration applied (it writes and deletes its own tenant):
//
//   createdb orderhub_retail_it
//   DATABASE_URL=… DIRECT_URL=… pnpm --filter @orderhub/database exec prisma migrate deploy
//   RETAIL_IT_DATABASE_URL=… pnpm --filter api test -- retail.integration

import { PrismaClient } from "@orderhub/database";
import { MenuAssignmentsService } from "../../menus/menu-assignments.service";
import { RetailCatalogService } from "../retail-catalog.service";
import { RetailReturnsService } from "../retail-returns.service";
import { RetailStockService } from "../retail-stock.service";

const URL = process.env.RETAIL_IT_DATABASE_URL;
const d = URL ? describe : describe.skip;

d("retail R1 (database)", () => {
  let prisma: PrismaClient;
  let stock: RetailStockService;
  let catalog: RetailCatalogService;
  let returns: RetailReturnsService;
  const refundStripeAmount = jest.fn(async () => "re_test_123");
  // Behaves like DojoService's card-machine refund: start stores the session
  // (with our context) on the payment; a "tapped" status books the Refund row
  // exactly as recordRefund does and clears the session.
  let machineOutcome: "waiting" | "tapped" | "declined" = "waiting";
  const dojoStub = {
    startTerminalRefund: jest.fn(async (a: any) => {
      const p = await prisma.payment.findFirstOrThrow({ where: { providerChargeId: a.paymentIntentId } });
      await prisma.payment.update({
        where: { id: p.id },
        data: {
          metadata: {
            refundSession: { id: `ses_${p.id}`, amountMinor: Math.round(a.amount * 100), context: a.context },
          },
        },
      });
      return { terminalSessionId: `ses_${p.id}`, amount: a.amount, status: "InitiateRequested" };
    }),
    terminalRefundStatus: jest.fn(async (_t: string, pi: string) => {
      const p = await prisma.payment.findFirstOrThrow({ where: { providerChargeId: pi } });
      const s = (p.metadata as any).refundSession;
      if (machineOutcome === "waiting") return { active: true, done: false, failed: false, prompt: "PresentCard" };
      await prisma.payment.update({ where: { id: p.id }, data: { metadata: { refundSession: null } } });
      if (machineOutcome === "declined") return { active: true, done: false, failed: true, message: "Declined" };
      await prisma.refund.create({
        data: {
          tenantId,
          paymentId: p.id,
          amount: s.amountMinor / 100,
          status: "SUCCEEDED",
          isPartial: true,
          note: `Dojo terminal refund ${s.id}`,
        },
      });
      return { active: true, done: true, failed: false };
    }),
  };
  const tag = `it${Date.now()}`;
  let tenantId: string;
  let brandId: string;
  let shopId: string;
  let restaurantId: string;
  const owner = () => ({ userId: "u-owner", tenantId, role: "TENANT_OWNER" as any, permissions: [] });
  const cashier = () => ({ userId: "u-cashier", tenantId, role: "CASHIER" as any, permissions: [] });

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    const tenant = await prisma.tenant.create({ data: { name: tag, slug: tag } });
    tenantId = tenant.id;
    const brand = await prisma.brand.create({ data: { tenantId, name: "Corner Shop", slug: `${tag}-shop` } });
    brandId = brand.id;
    shopId = (
      await prisma.location.create({ data: { brandId, name: "High St", address: {}, businessType: "GROCERY" } })
    ).id;
    restaurantId = (await prisma.location.create({ data: { brandId, name: "Grill", address: {} } })).id;

    stock = new RetailStockService(prisma as any);
    // The till's menu, read straight from the tables: every item in the menu
    // assigned to the location's POS. Stands in for MenusService, whose
    // publish/snooze rules are not what is under test here.
    const menusStub = {
      findActiveMenuForLocation: async (locationId: string) => {
        const a = await prisma.menuChannelAssignment.findFirst({ where: { locationId, channel: "POS" } });
        if (!a) return null;
        const cats = await prisma.menuCategory.findMany({
          where: { menuId: a.menuId },
          include: { items: { include: { item: { select: { id: true } } } } },
        });
        return { categories: cats };
      },
    };
    let n = 0;
    const pluStub = { generateUnique: async () => `PROD-${tag}-${++n}` };
    catalog = new RetailCatalogService(
      prisma as any,
      menusStub as any,
      new MenuAssignmentsService(prisma as any),
      pluStub as any,
      stock,
    );
    returns = new RetailReturnsService(
      prisma as any,
      { resolveOrderAccessWhere: async (u: any) => ({ tenantId: u.tenantId }) } as any,
      {
        assertPin: async (_loc: string, pin: string) => {
          if (pin !== "1234") throw new Error("Incorrect manager PIN");
        },
      } as any,
      { refundStripeAmount } as any,
      stock,
      { emitToTenant: () => undefined } as any,
      { emit: () => undefined } as any,
      dojoStub as any,
    );
  });

  afterAll(async () => {
    if (!prisma) return;
    // Children first: nothing here cascades from the tenant.
    const orders = await prisma.order.findMany({ where: { tenantId }, select: { id: true } });
    const orderIds = orders.map((o) => o.id);
    await prisma.ledgerEntry.deleteMany({ where: { tenantId } });
    await prisma.refund.deleteMany({ where: { tenantId } });
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.productStockMovement.deleteMany({ where: { tenantId } });
    await prisma.productVariant.deleteMany({ where: { tenantId } });
    await prisma.menuItem.deleteMany({ where: { brandId } });
    await prisma.menu.deleteMany({ where: { brandId } });
    await prisma.location.deleteMany({ where: { brandId } });
    await prisma.brand.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  const levelOf = async (variantId: string, locationId = shopId) =>
    (await prisma.productStockLevel.findUnique({
      where: { variantId_locationId: { variantId, locationId } },
    }))?.quantity ?? 0;

  const variantByBarcode = (barcode: string) =>
    prisma.productVariant.findFirstOrThrow({ where: { brandId, barcode } });

  async function sale(opts: {
    locationId?: string;
    lines: Array<{ name: string; qty: number; total: number; menuItemId: string; variantId?: string; sku?: string }>;
    discount?: number;
    paymentMethod?: string;
  }) {
    const subtotal = opts.lines.reduce((s, l) => s + l.total, 0);
    const discount = opts.discount ?? 0;
    return prisma.order.create({
      data: {
        tenantId,
        locationId: opts.locationId ?? shopId,
        brandId,
        platform: "POS",
        orderSource: "POS",
        externalId: `${tag}-${Math.random()}`,
        customerInfo: {},
        isWalkIn: true,
        fulfillmentType: "PICKUP",
        status: "PENDING",
        paymentStatus: "PAID",
        paymentMethod: opts.paymentMethod ?? "CASH",
        subtotal,
        discount,
        total: subtotal - discount,
        items: {
          create: opts.lines.map((l) => ({
            name: l.name,
            quantity: l.qty,
            unitPrice: l.total / l.qty,
            totalPrice: l.total,
            menuItemId: l.menuItemId,
            metadata: { ...(l.variantId ? { variantId: l.variantId } : {}), ...(l.sku ? { sku: l.sku } : {}) },
          })),
        },
      } as any,
      include: { items: true },
    });
  }

  it("imports a sheet into a new Shop menu the till can scan", async () => {
    const r = await catalog.importRows({
      tenantId,
      locationId: shopId,
      userId: "u-owner",
      rows: [
        { Name: "Coke 330ml", Price: "£1.25", Barcode: "5000112637922", Stock: 24, Category: "Drinks" },
        { Name: "Milk 2L", Price: "1.55", Barcode: "5000128104517", Stock: 10, Category: "Dairy" },
        { Name: "Oxford Shirt", Price: 30, Size: "M", Barcode: "2000000000011", Stock: 3 },
        { Name: "Oxford Shirt", Price: 32, Size: "L", Barcode: "2000000000028", Stock: 2 },
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ products: 3, created: 3, variantsCreated: 4, stockSet: 4 });
    expect(r.menu).toMatchObject({ name: "Shop", created: true });

    const index = await catalog.barcodeIndex(tenantId, shopId);
    expect(index.map((e) => [e.barcode, e.name, e.price]).sort()).toEqual(
      [
        ["2000000000011", "Oxford Shirt — M", 30],
        ["2000000000028", "Oxford Shirt — L", 32],
        ["5000112637922", "Coke 330ml", 1.25],
        ["5000128104517", "Milk 2L", 1.55],
      ].sort(),
    );

    // The shirt's sizes are mirrored into productSkus so every size picker offers them.
    const shirt = await prisma.menuItem.findFirstOrThrow({ where: { brandId, name: "Oxford Shirt" } });
    expect(shirt.hasMultipleSkus).toBe(true);
    expect((shirt.productSkus as any[]).map((s) => [s.name, s.price])).toEqual([
      ["M", 30],
      ["L", 32],
    ]);
    expect(await levelOf((await variantByBarcode("5000112637922")).id)).toBe(24);
  });

  it("re-importing the same sheet updates in place instead of duplicating", async () => {
    const r = await catalog.importRows({
      tenantId,
      locationId: shopId,
      userId: "u-owner",
      rows: [{ Name: "Coke 330ml", Price: "1.35", Barcode: "5000112637922", Stock: 30 }],
    });
    expect(r).toMatchObject({ created: 0, updated: 1, variantsCreated: 0, variantsUpdated: 1 });
    expect(await prisma.menuItem.count({ where: { brandId, name: "Coke 330ml" } })).toBe(1);
    const coke = await prisma.menuItem.findFirstOrThrow({ where: { brandId, name: "Coke 330ml" } });
    expect(Number(coke.basePrice)).toBe(1.35);
    // A count, booked as the difference: 24 → 30 is +6 in the ledger.
    const v = await variantByBarcode("5000112637922");
    expect(await levelOf(v.id)).toBe(30);
    const last = await prisma.productStockMovement.findFirstOrThrow({
      where: { variantId: v.id },
      orderBy: { createdAt: "desc" },
    });
    expect(last).toMatchObject({ type: "COUNT_CORRECTION", quantity: 6 });
  });

  it("refuses a barcode that is already on another product", async () => {
    const milk = await prisma.menuItem.findFirstOrThrow({ where: { brandId, name: "Milk 2L" } });
    await expect(
      catalog.createVariant(tenantId, milk.id, { name: "Twin", barcode: "5000112637922" }),
    ).rejects.toThrow(/already on another product/);
  });

  it("takes stock once per sale however often the status event fires, and gives it back once on cancel", async () => {
    const coke = await variantByBarcode("5000112637922");
    const shirtL = await variantByBarcode("2000000000028");
    const order = await sale({
      lines: [
        { name: "Coke", qty: 2, total: 2.7, menuItemId: coke.menuItemId, variantId: coke.id },
        // A size picked in the picker: no variantId, but its sku.
        { name: "Oxford Shirt L", qty: 1, total: 32, menuItemId: shirtL.menuItemId, sku: shirtL.sku! },
      ],
    });
    const cokeBefore = await levelOf(coke.id);
    const shirtBefore = await levelOf(shirtL.id);

    await stock.onOrderStatusChanged({ orderId: order.id, toStatus: "ACCEPTED" });
    await stock.onOrderStatusChanged({ orderId: order.id, toStatus: "COMPLETED" });
    await Promise.all([
      stock.onOrderStatusChanged({ orderId: order.id, toStatus: "COMPLETED" }),
      stock.onOrderStatusChanged({ orderId: order.id, toStatus: "COMPLETED" }),
    ]);
    expect(await levelOf(coke.id)).toBe(cokeBefore - 2);
    expect(await levelOf(shirtL.id)).toBe(shirtBefore - 1);

    await stock.onOrderStatusChanged({ orderId: order.id, toStatus: "CANCELLED" });
    await stock.onOrderStatusChanged({ orderId: order.id, toStatus: "CANCELLED" });
    expect(await levelOf(coke.id)).toBe(cokeBefore);
    expect(await levelOf(shirtL.id)).toBe(shirtBefore);
  });

  it("leaves a restaurant's orders alone", async () => {
    const coke = await variantByBarcode("5000112637922");
    const order = await sale({
      locationId: restaurantId,
      lines: [{ name: "Coke", qty: 1, total: 1.35, menuItemId: coke.menuItemId, variantId: coke.id }],
    });
    expect(await stock.syncOrder(order.id, "commit")).toBe(0);
  });

  it("returns part of a cash sale: cash back, stock back, then the rest", async () => {
    const milk = await variantByBarcode("5000128104517");
    const order = await sale({
      lines: [{ name: "Milk 2L", qty: 3, total: 4.65, menuItemId: milk.menuItemId, variantId: milk.id }],
    });
    await stock.syncOrder(order.id, "commit");
    const afterSale = await levelOf(milk.id);

    const found = await returns.findSale(owner(), shopId, `OHR:${order.id}`);
    expect(found.items[0]).toMatchObject({ returnable: 3 });
    expect(found.original).toMatchObject({ method: "CASH", supported: true });

    const first = await returns.createReturn(owner(), {
      orderId: order.id,
      lines: [{ orderItemId: order.items[0]!.id, quantity: 1 }],
      reason: "Leaking",
    });
    expect(first).toMatchObject({ amount: 1.55, method: "CASH" });
    expect(first.sale.items[0]).toMatchObject({ returnable: 2 });
    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: first.refundId }, include: { lines: true } });
    expect(refund).toMatchObject({ paymentId: null, orderId: order.id, method: "CASH", isPartial: true });
    expect(refund.lines).toHaveLength(1);
    expect(await levelOf(milk.id)).toBe(afterSale + 1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe(
      "PARTIALLY_REFUNDED",
    );

    await expect(
      returns.createReturn(owner(), { orderId: order.id, lines: [{ orderItemId: order.items[0]!.id, quantity: 3 }] }),
    ).rejects.toThrow("Only 2 × Milk 2L can still be returned");

    // Damaged: refunded but NOT restocked.
    await returns.createReturn(owner(), {
      orderId: order.id,
      lines: [{ orderItemId: order.items[0]!.id, quantity: 2, restock: false }],
    });
    expect(await levelOf(milk.id)).toBe(afterSale + 1);
    const done = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(done.paymentStatus).toBe("REFUNDED");
    await expect(
      returns.createReturn(owner(), { orderId: order.id, lines: [{ orderItemId: order.items[0]!.id, quantity: 1 }] }),
    ).rejects.toThrow(/already been refunded/);
  });

  it("needs the manager PIN when a cashier takes the return", async () => {
    const coke = await variantByBarcode("5000112637922");
    const order = await sale({
      lines: [{ name: "Coke", qty: 1, total: 1.35, menuItemId: coke.menuItemId, variantId: coke.id }],
    });
    const input = { orderId: order.id, lines: [{ orderItemId: order.items[0]!.id, quantity: 1 }] };
    await expect(returns.createReturn(cashier(), input)).rejects.toThrow(/manager PIN/);
    await expect(returns.createReturn(cashier(), { ...input, managerPin: "0000" })).rejects.toThrow(/Incorrect/);
    await expect(returns.createReturn(cashier(), { ...input, managerPin: "1234" })).resolves.toMatchObject({
      amount: 1.35,
    });
  });

  it("refunds a Stripe card sale to the card, pro-rata to the discount", async () => {
    const shirtM = await variantByBarcode("2000000000011");
    const order = await sale({
      paymentMethod: "CARD_TERMINAL",
      discount: 6, // £60 basket, £6 off → 10% off every line
      lines: [{ name: "Oxford Shirt M", qty: 2, total: 60, menuItemId: shirtM.menuItemId, variantId: shirtM.id }],
    });
    const payment = await prisma.payment.create({
      data: {
        tenantId,
        orderId: order.id,
        amount: 54,
        netAmount: 54,
        status: "SUCCEEDED",
        method: "CARD",
        provider: "STRIPE",
        stripePaymentIntentId: `pi_${tag}`,
      } as any,
    });
    refundStripeAmount.mockClear();
    const r = await returns.createReturn(owner(), {
      orderId: order.id,
      lines: [{ orderItemId: order.items[0]!.id, quantity: 1 }],
    });
    expect(r).toMatchObject({ amount: 27, method: "CARD" });
    expect(refundStripeAmount).toHaveBeenCalledWith(
      expect.objectContaining({ id: payment.id }),
      2700,
      expect.objectContaining({ kind: "retail_return" }),
    );
    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: r.refundId } });
    expect(refund).toMatchObject({ paymentId: payment.id, stripeRefundId: "re_test_123", method: "CARD" });
  });

  it("refunds a Dojo card-present sale on the card machine, then books the lines once", async () => {
    const coke = await variantByBarcode("5000112637922");
    const order = await sale({
      paymentMethod: "CARD_TERMINAL",
      lines: [{ name: "Coke", qty: 2, total: 2.7, menuItemId: coke.menuItemId, variantId: coke.id }],
    });
    await prisma.payment.create({
      data: {
        tenantId,
        orderId: order.id,
        amount: 2.7,
        netAmount: 2.7,
        status: "SUCCEEDED",
        method: "CARD",
        provider: "DOJO",
        providerChargeId: `pi_dojo_${tag}`,
      } as any,
    });
    await stock.syncOrder(order.id, "commit");
    const afterSale = await levelOf(coke.id);
    const line = order.items[0]!.id;

    expect((await returns.findSale(owner(), shopId, `OHR:${order.id}`)).original).toMatchObject({
      provider: "DOJO",
      supported: true,
    });

    machineOutcome = "waiting";
    const started = await returns.createReturn(owner(), {
      orderId: order.id,
      lines: [{ orderItemId: line, quantity: 1 }],
      terminalId: "term_1",
    });
    expect(started).toMatchObject({ pending: true, provider: "DOJO", amount: 1.35 });
    expect(dojoStub.startTerminalRefund).toHaveBeenLastCalledWith(
      expect.objectContaining({ amount: 1.35, terminalId: "term_1" }),
    );
    // Nothing is booked, and nothing else can be returned, until the card is tapped.
    expect(await prisma.refund.count({ where: { payment: { orderId: order.id } } })).toBe(0);
    await expect(
      returns.createReturn(owner(), { orderId: order.id, lines: [{ orderItemId: line, quantity: 1 }], refundMethod: "CASH" }),
    ).rejects.toThrow(/waiting on the card machine/);
    await expect(returns.pollDojoReturn(owner(), order.id)).resolves.toMatchObject({ done: false, prompt: "PresentCard" });

    machineOutcome = "tapped";
    const done: any = await returns.pollDojoReturn(owner(), order.id);
    expect(done).toMatchObject({ done: true });
    expect(done.sale.items[0]).toMatchObject({ returnable: 1 });
    const refund = await prisma.refund.findFirstOrThrow({
      where: { payment: { orderId: order.id } },
      include: { lines: true, ledgerEntries: true },
    });
    expect(refund).toMatchObject({ orderId: order.id, method: "CARD" });
    expect(refund.lines).toHaveLength(1);
    expect(refund.ledgerEntries).toHaveLength(1);
    expect(await levelOf(coke.id)).toBe(afterSale + 1);

    // The drawer's poll (or a retried event) lands the same session again: no double booking.
    const session = {
      id: refund.note!.replace("Dojo terminal refund ", ""),
      context: {
        kind: "retail_return",
        lines: [{ orderItemId: line, quantity: 1, amountMinor: 135, restock: true }],
        reason: null,
      },
    };
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    await returns.onDojoRefundRecorded({ tenantId, paymentId: pay.id, orderId: order.id, session });
    expect(await prisma.refundLine.count({ where: { refundId: refund.id } })).toBe(1);
    expect(await levelOf(coke.id)).toBe(afterSale + 1);
  });

  it("books nothing when the card machine declines, and cash still works", async () => {
    const coke = await variantByBarcode("5000112637922");
    const order = await sale({
      paymentMethod: "CARD_TERMINAL",
      lines: [{ name: "Coke", qty: 1, total: 1.35, menuItemId: coke.menuItemId, variantId: coke.id }],
    });
    await prisma.payment.create({
      data: {
        tenantId,
        orderId: order.id,
        amount: 1.35,
        netAmount: 1.35,
        status: "SUCCEEDED",
        method: "CARD",
        provider: "DOJO",
        providerChargeId: `pi_dojo2_${tag}`,
      } as any,
    });
    const input = { orderId: order.id, lines: [{ orderItemId: order.items[0]!.id, quantity: 1 }] };
    machineOutcome = "declined";
    await returns.createReturn(owner(), input);
    await expect(returns.pollDojoReturn(owner(), order.id)).resolves.toMatchObject({ failed: true });
    expect(await prisma.refund.count({ where: { payment: { orderId: order.id } } })).toBe(0);
    await expect(returns.createReturn(owner(), { ...input, refundMethod: "CASH" })).resolves.toMatchObject({
      method: "CASH",
    });
  });

  it("finds a sale by the number printed on the receipt", async () => {
    const coke = await variantByBarcode("5000112637922");
    const order = await sale({
      lines: [{ name: "Coke", qty: 1, total: 1.35, menuItemId: coke.menuItemId, variantId: coke.id }],
    });
    await prisma.order.update({ where: { id: order.id }, data: { displayId: "K7Q2M" } });
    await expect(returns.findSale(owner(), shopId, "#k7q2m")).resolves.toMatchObject({
      order: { id: order.id },
    });
  });
});
