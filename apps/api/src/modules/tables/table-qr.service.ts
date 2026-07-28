import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrdersService } from "../orders/orders.service";

// QR at table — a guest scans the sticker on their table and orders from
// their own phone. The round lands on that table's existing tab, so the
// bill, the kitchen routing and the settle path are all the ones staff
// already use. Nothing here touches money: QR rounds are added to the
// tab and paid at the end, with staff, exactly like a waiter round.
//
// Security model: the token is the only credential, so it is
//   • opaque and rotatable (POST /tables/:id/qr mints a fresh one, which
//     instantly kills any sticker already on the table),
//   • individually switchable (qrEnabled),
//   • gated on the LOCATION having table service on,
//   • never accepted for a table that is out of service.
//
// A scan can only ever ADD to the table it belongs to. It cannot read
// other tables, cannot settle, cannot discount.

export interface QrOrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  modifiers?: { name: string; price: number; quantity?: number }[];
  notes?: string | null;
  menuItemId?: string | null;
}

// Guest phones drop connections constantly (lock screen, lift, patchy
// venue wifi). Without a guard, a retry after the request already
// reached us plates the round twice — the one failure mode that costs
// the restaurant real food. The phone sends a stable requestId per
// basket; we remember what we did with it for a few minutes and replay
// the same answer instead of cooking it again.
//
// In-memory is the right size for this: the whole risk window is
// seconds, the cost of a rare miss on a restarted/other instance is one
// duplicate round, and the alternative is a schema change for a cache.
// The OPEN path additionally passes the id through to orders.create()'s
// existing idempotencyKey, which IS durable.
const REPLAY_TTL_MS = 5 * 60_000;

@Injectable()
export class TableQrService {
  private readonly recent = new Map<
    string,
    { at: number; result: { orderId: string; tableName: string; mode: "OPEN" | "ROUND" } }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  private replay(key: string) {
    const hit = this.recent.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > REPLAY_TTL_MS) {
      this.recent.delete(key);
      return null;
    }
    return hit.result;
  }

  private remember(
    key: string,
    result: { orderId: string; tableName: string; mode: "OPEN" | "ROUND" },
  ) {
    // Opportunistic sweep — this map only ever holds a few minutes of
    // one venue's scans, so a full pass is cheaper than a timer.
    const cutoff = Date.now() - REPLAY_TTL_MS;
    for (const [k, v] of this.recent) if (v.at < cutoff) this.recent.delete(k);
    this.recent.set(key, { at: Date.now(), result });
  }

  /**
   * Resolve a scanned token to just enough context for the guest's phone
   * to render the right menu. Deliberately thin — no other tables, no
   * takings, no customer data.
   */
  async resolve(token: string) {
    const table = await this.prisma.table.findFirst({
      where: { qrToken: token, qrEnabled: true, isActive: true },
      include: {
        location: {
          select: {
            id: true,
            name: true,
            settings: true,
            brand: { select: { id: true, name: true, slug: true, tenantId: true } },
          },
        },
      },
    });
    if (!table) throw new NotFoundException("This QR code is no longer valid");

    const ts = ((table.location?.settings as any) ?? {})?.tableService ?? {};
    if (!ts.enabled) {
      throw new ForbiddenException("Table ordering isn't available here");
    }
    if (table.outOfService) {
      throw new ForbiddenException(
        "This table isn't taking orders — please ask a member of staff",
      );
    }

    return {
      tableId: table.id,
      tableName: table.name,
      locationId: table.locationId,
      locationName: table.location?.name ?? null,
      brandId: table.location?.brand?.id ?? null,
      brandName: table.location?.brand?.name ?? null,
      brandSlug: table.location?.brand?.slug ?? null,
      // True once a waiter (or an earlier scan) has already opened the
      // tab — the phone can then show "adding to your table".
      tabOpen: !!table.currentOrderId,
      // Guests may be asked to confirm how many are eating, once.
      covers: table.covers,
    };
  }

  /**
   * Place a guest round. Creates the tab if this is the first order on
   * the table, otherwise appends — identical to what the POS does, so a
   * table can mix waiter rounds and phone rounds freely.
   */
  async placeOrder(
    token: string,
    input: {
      items: QrOrderItem[];
      customerName?: string;
      notes?: string | null;
      /** Stable per-basket id from the phone; makes retries safe. */
      requestId?: string;
    },
  ) {
    const replayKey = input.requestId ? `${token}:${input.requestId}` : null;
    if (replayKey) {
      const already = this.replay(replayKey);
      if (already) return already;
    }
    const table = await this.prisma.table.findFirst({
      where: { qrToken: token, qrEnabled: true, isActive: true },
      include: {
        location: {
          select: {
            id: true,
            settings: true,
            brand: { select: { id: true, tenantId: true } },
          },
        },
      },
    });
    if (!table) throw new NotFoundException("This QR code is no longer valid");

    const tenantId = table.location?.brand?.tenantId;
    if (!tenantId) throw new NotFoundException("Location not found");

    const ts = ((table.location?.settings as any) ?? {})?.tableService ?? {};
    if (!ts.enabled) {
      throw new ForbiddenException("Table ordering isn't available here");
    }
    if (table.outOfService) {
      throw new ForbiddenException(
        "This table isn't taking orders — please ask a member of staff",
      );
    }

    const items = (input.items ?? []).filter(
      (i) => i?.name && Number(i.quantity) > 0,
    );
    if (!items.length) throw new BadRequestException("Your basket is empty");

    const guestName = input.customerName?.trim() || table.name;

    // Existing tab → append a round. This reuses the SAME path the POS
    // uses, so only the new lines fire to the kitchen and prior KDS
    // tick-states survive.
    if (table.currentOrderId) {
      const order = await this.orders.addRound(
        table.currentOrderId,
        tenantId,
        items,
        // No staff user behind a guest scan; attribute it to the table.
        `qr:${table.id}`,
      );
      const out = {
        orderId: order.id,
        tableName: table.name,
        mode: "ROUND" as const,
      };
      if (replayKey) this.remember(replayKey, out);
      return out;
    }

    // First order on this table → open the tab.
    const subtotal = items.reduce((s, i) => s + Number(i.totalPrice || 0), 0);
    const created = await this.orders.create(
      {
        locationId: table.locationId,
        brandId: table.location?.brand?.id ?? undefined,
        orderSource: "POS",
        fulfillmentType: "DINE_IN",
        tableId: table.id,
        customerInfo: { name: guestName },
        items: items as any,
        subtotal,
        total: subtotal,
        specialInstructions: input.notes?.trim() || undefined,
        // Durable dedupe for the first round — create() already
        // supports this, so an OPEN retry can't produce two tabs.
        ...(input.requestId
          ? { idempotencyKey: `tableqr:${table.id}:${input.requestId}` }
          : {}),
      } as any,
      tenantId,
    );

    await this.prisma.table.update({
      where: { id: table.id },
      data: {
        status: "OCCUPIED",
        currentOrderId: created.id,
        openedAt: table.openedAt ?? new Date(),
      },
    });

    const out = {
      orderId: created.id,
      tableName: table.name,
      mode: "OPEN" as const,
    };
    if (replayKey) this.remember(replayKey, out);
    return out;
  }

  /**
   * What's on my table so far. Guests get their own running total and
   * nothing else — no other tables, no staff notes, no payment data.
   */
  async myTab(token: string) {
    const table = await this.prisma.table.findFirst({
      where: { qrToken: token, qrEnabled: true, isActive: true },
      select: { id: true, name: true, currentOrderId: true },
    });
    if (!table) throw new NotFoundException("This QR code is no longer valid");
    if (!table.currentOrderId) {
      return { tableName: table.name, items: [], total: 0, open: false };
    }
    const order = await this.prisma.order.findUnique({
      where: { id: table.currentOrderId },
      include: {
        items: {
          select: { id: true, name: true, quantity: true, totalPrice: true },
        },
      },
    });
    return {
      tableName: table.name,
      open: true,
      items: (order?.items ?? []).map((i) => ({
        id: i.id,
        name: i.name,
        quantity: i.quantity,
        totalPrice: Number(i.totalPrice),
      })),
      total: Number(order?.total ?? 0),
      paymentStatus: order?.paymentStatus ?? null,
    };
  }
}
