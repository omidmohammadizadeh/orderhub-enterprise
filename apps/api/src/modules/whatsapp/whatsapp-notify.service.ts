import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { WhatsAppSendService } from "./whatsapp-send.service";

// Phase AY (P5) — push order status updates back into the customer's WhatsApp
// chat. Driven by the in-process "order.status_changed" event (emitted by
// OrdersService.updateStatus) so there's no module cycle. Only WHATSAPP-source
// orders are notified; everything else is ignored.
interface OrderStatusEvent {
  orderId: string;
  tenantId: string;
  locationId: string | null;
  fromStatus: string;
  toStatus: string;
}

@Injectable()
export class WhatsAppNotifyService {
  private readonly logger = new Logger(WhatsAppNotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly send: WhatsAppSendService,
  ) {}

  // Fires the moment Stripe authorises the card (PaymentsService.markAuthorized
  // emits "payment.authorized"). Sends an immediate "payment received" so the
  // customer — just bounced back to the chat by the wa.me redirect — sees
  // confirmation without waiting for the kitchen to accept.
  @OnEvent("payment.authorized")
  async onPaymentAuthorized(ev: { orderId: string }): Promise<void> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: ev.orderId },
        select: {
          orderSource: true,
          customerPhone: true,
          displayId: true,
          metadata: true,
        },
      });
      if (!order || (order.orderSource as string) !== "WHATSAPP") return;
      const meta = (order.metadata as any) ?? {};
      const phoneNumberId: string | undefined = meta.phoneNumberId;
      const to: string | undefined = order.customerPhone ?? meta.waPhone;
      if (!phoneNumberId || !to) return;
      const id = order.displayId ? `#${order.displayId}` : "your order";
      await this.send.sendText(
        phoneNumberId,
        to,
        `✅ Payment received for ${id} — thank you! 🎉 We're sending it to the kitchen now; you'll get a message the moment it's confirmed.`,
      );
    } catch (err: any) {
      this.logger.warn(
        `WhatsApp payment-authorized notify failed for ${ev.orderId}: ${err?.message ?? err}`,
      );
    }
  }

  @OnEvent("order.status_changed")
  async onStatusChange(ev: OrderStatusEvent): Promise<void> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: ev.orderId },
        select: {
          orderSource: true,
          customerPhone: true,
          displayId: true,
          fulfillmentType: true,
          metadata: true,
          location: { select: { name: true } },
        },
      });
      if (!order || (order.orderSource as string) !== "WHATSAPP") return;

      const meta = (order.metadata as any) ?? {};
      const phoneNumberId: string | undefined = meta.phoneNumberId;
      const to: string | undefined = order.customerPhone ?? meta.waPhone;
      if (!phoneNumberId || !to) return;

      const msg = this.messageFor(ev.toStatus, order);
      if (!msg) return;
      await this.send.sendText(phoneNumberId, to, msg);
    } catch (err: any) {
      this.logger.warn(`WhatsApp status notify failed for ${ev.orderId}: ${err?.message ?? err}`);
    }
  }

  private messageFor(
    toStatus: string,
    order: { displayId: string | null; fulfillmentType: string; location: { name: string } | null },
  ): string | null {
    const id = order.displayId ? `#${order.displayId}` : "your order";
    const delivery = order.fulfillmentType === "DELIVERY";
    const shop = order.location?.name;
    switch (toStatus) {
      case "ACCEPTED":
        return `👨‍🍳 ${id} is confirmed — the kitchen is preparing it now!`;
      case "READY":
        return delivery
          ? `🎉 ${id} is ready and heading out for delivery shortly!`
          : `🎉 ${id} is ready for collection!`;
      case "OUT_FOR_DELIVERY":
      case "DISPATCHED":
        return `🛵 ${id} is on its way — it'll be with you soon!`;
      case "COMPLETED":
        return `✅ ${id} complete — thanks for ordering${shop ? ` from ${shop}` : ""}! 🙏`;
      case "CANCELLED":
      case "REJECTED":
        return `😔 Sorry, ${id} was cancelled. Any payment will be refunded or the hold released.`;
      default:
        return null; // PENDING/PREPARING/etc. — stay quiet
    }
  }
}
