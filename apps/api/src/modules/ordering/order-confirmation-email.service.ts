import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { EmailService } from "../../infrastructure/email/email.service";

// The confirmation email a customer gets after ordering online.
//
// WHY A SWEEP AND NOT A HOOK IN CHECKOUT
//
// `OrderingService.checkout` has three exits — cash/pay-later returns a placed
// order, embedded card returns a client secret, hosted checkout returns a
// redirect — and for the card routes the order is not real until Stripe (or
// Tap) says so, on one of several webhooks. Emailing from checkout would
// confirm orders that were never paid for; hooking each payment path instead
// means finding every one of them, and the auto-accept guard already taught us
// what happens when a rule has to be repeated in four places and one is missed.
//
// So this reads the finished state instead. One query, every payment route
// covered by construction, and nothing in the money path can be broken by an
// email provider having a bad day. The cost is up to a minute's delay, which
// for a confirmation email is nothing.
//
// IDEMPOTENCY lives on `Order.metadata.confirmationEmail`. A second
// "order confirmed" for the same order reads to a customer as a second order,
// so the marker is written only after Resend accepts the send — a failure
// leaves the order unmarked and the next sweep retries it.

/** Orders older than this are not worth emailing about any more. Also stops a
 *  backlog (or a restored database) from mailing a month of history at once. */
const LOOKBACK_HOURS = 6;
/** Belt and braces against a runaway sweep burning the daily allowance. */
const BATCH = 25;

@Injectable()
export class OrderConfirmationEmailService {
  private readonly logger = new Logger(OrderConfirmationEmailService.name);
  /** The day we last warned about the cap, so it is one warning, not sixty. */
  private warnedOn: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() private readonly email?: EmailService,
  ) {}

  private cfg<T>(key: string): T | undefined {
    return this.config?.get<T>(`app.orderEmails.${key}`);
  }

  @Cron("*/30 * * * * *")
  async sweep(): Promise<void> {
    try {
      if (!this.cfg<boolean>("enabled")) return;

      const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000);
      const orders = await this.prisma.order.findMany({
        where: {
          platform: "ONLINE" as any,
          createdAt: { gte: since },
          // Only orders that actually happened. A card order sits PENDING
          // until its webhook lands; a cancelled one must never be confirmed.
          status: { notIn: ["PENDING", "CANCELLED", "REJECTED"] as any },
          NOT: { metadata: { path: ["confirmationEmail", "sentAt"], not: null as any } },
        },
        orderBy: { createdAt: "asc" },
        take: BATCH,
        include: {
          items: { include: { modifiers: true } },
          location: { select: { name: true, onlineOrderingSlug: true, slug: true } },
          brand: { select: { name: true } },
        } as any,
      });
      if (orders.length === 0) return;

      // One count for the batch. Resend's free plan stops dead at its daily
      // limit, and a customer silently not getting a confirmation looks
      // identical to the order not existing.
      const cap = Number(this.cfg<number>("dailyCap") ?? 100);
      const warnAt = Number(this.cfg<number>("capWarnAt") ?? 80);
      let sentToday = await this.countToday();

      for (const order of orders as any[]) {
        if ((order?.metadata as any)?.confirmationEmail?.sentAt) continue;
        const to = this.addressFor(order);
        if (!to) continue;

        if (sentToday >= cap) {
          // Deliberately NOT marked: it goes out on tomorrow's allowance
          // rather than never. Warn once, then stop spending requests.
          await this.warnAboutCap(sentToday, cap, true);
          this.logger.warn(
            `Order confirmation emails paused — ${sentToday}/${cap} sent today`,
          );
          return;
        }

        try {
          await this.email?.send({
            to,
            subject: `Order ${this.reference(order)} confirmed — ${this.shopName(order)}`,
            html: this.body(order),
          });
        } catch (e: any) {
          // Leave it unmarked. The next sweep tries again, which is the right
          // answer for a 503 and harmless for anything else.
          this.logger.warn(
            `Order confirmation email failed for ${order.id}: ${e?.message}`,
          );
          continue;
        }

        sentToday += 1;
        await this.markSent(order, to);
      }

      if (sentToday >= warnAt) await this.warnAboutCap(sentToday, cap, false);
    } catch (e: any) {
      // An order is never affected by its email. Terminal on purpose.
      this.logger.warn(`Order confirmation sweep failed: ${e?.message}`);
    }
  }

  /** Emails we have sent today, counted from the log rows we write. */
  private async countToday(): Promise<number> {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    try {
      return await (this.prisma as any).notificationLog.count({
        where: { channel: "EMAIL", createdAt: { gte: midnight } },
      });
    } catch {
      return 0;
    }
  }

  /** Takes the order we already loaded rather than re-reading it: one less
   *  query per email, and the metadata we merge into is the one we judged. */
  private async markSent(order: any, to: string): Promise<void> {
    const orderId = order.id;
    try {
      const metadata = ((order?.metadata as any) ?? {}) as Record<string, unknown>;
      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          metadata: {
            ...metadata,
            confirmationEmail: { sentAt: new Date().toISOString(), to },
          } as any,
        },
      });
      // The counter the cap check reads. Also puts the send on the record.
      await (this.prisma as any).notificationLog.create({
        data: {
          tenantId: order?.tenantId ?? "",
          type: "ORDER_NEW",
          channel: "EMAIL",
          title: "Order confirmation",
          body: `Sent to ${to}`,
          data: { orderId } as any,
          status: "SENT",
        },
      });
    } catch (e: any) {
      // Worst case we send one duplicate after a restart; losing the email
      // entirely would be worse.
      this.logger.warn(`Could not mark ${orderId} as emailed: ${e?.message}`);
    }
  }

  private async warnAboutCap(sent: number, cap: number, atCap: boolean): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (this.warnedOn === today) return;
    this.warnedOn = today;
    const opsEmail = String(this.cfg<string>("opsAlertEmail") ?? "").trim();
    this.logger.warn(`Order confirmation emails at ${sent}/${cap} for today`);
    if (!opsEmail) return;
    await this.email
      ?.send({
        to: opsEmail,
        subject: atCap
          ? `Order emails STOPPED — daily cap of ${cap} reached`
          : `Order emails nearing the daily cap (${sent}/${cap})`,
        html:
          `<p>${sent} of today's ${cap} order confirmation emails have been sent.</p>` +
          (atCap
            ? `<p>Further confirmations are <b>not being sent</b> and will go out on tomorrow's allowance. Upgrading the Resend plan removes the daily limit.</p>`
            : `<p>Once the cap is reached, customers stop receiving confirmations until midnight.</p>`),
      })
      .catch(() => undefined);
  }

  // ── Composition ──────────────────────────────────────────────────────

  private addressFor(order: any): string | null {
    const raw =
      order?.customerInfo?.email ??
      order?.customer?.email ??
      order?.customerAccount?.email ??
      "";
    const email = String(raw).trim();
    return email.includes("@") ? email : null;
  }

  private reference(order: any): string {
    return String(order.displayId ?? order.orderNumber ?? order.id);
  }

  private shopName(order: any): string {
    // The brand is what the customer chose on a multi-brand site; the
    // location is only the kitchen it happens to be cooked in.
    return String(order.brand?.name ?? order.location?.name ?? "your order");
  }

  /** The canonical, bookmarkable tracking page for this order. */
  private trackingUrl(order: any): string {
    const origin = String(
      this.config?.get<string>("app.webUrl") ?? "https://www.orderhubsolutions.com",
    ).replace(/\/+$/, "");
    const slug = order.location?.onlineOrderingSlug || order.location?.slug || order.locationId;
    // `?brand=` REPLACES the storefront's menu and shop name, so it must be
    // the brand the ORDER chose — never the location's default.
    const brand = order.brandId ? `?brand=${encodeURIComponent(order.brandId)}` : "";
    return `${origin}/order/${encodeURIComponent(slug)}/status/${encodeURIComponent(order.id)}${brand}`;
  }

  private money(v: unknown): string {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n.toFixed(2) : "0.00";
  }

  private body(order: any): string {
    const rows = (order.items ?? [])
      .map((i: any) => {
        const mods = (i.modifiers ?? [])
          .map((m: any) => m?.name)
          .filter(Boolean)
          .join(", ");
        return (
          `<tr><td style="padding:6px 0">${i.quantity} × ${this.esc(i.name)}` +
          (mods ? `<br/><span style="color:#71717a;font-size:13px">${this.esc(mods)}</span>` : "") +
          `</td><td align="right" style="padding:6px 0">${this.money(i.totalPrice)}</td></tr>`
        );
      })
      .join("");

    const line = (label: string, value: unknown) =>
      Number(value ?? 0) > 0
        ? `<tr><td style="padding:2px 0;color:#71717a">${label}</td><td align="right" style="padding:2px 0">${this.money(value)}</td></tr>`
        : "";

    return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#18181b">
  <h2 style="margin:0 0 4px">Thanks — your order is confirmed</h2>
  <p style="margin:0 0 20px;color:#71717a">${this.esc(this.shopName(order))} · Order ${this.esc(this.reference(order))}</p>

  <p style="margin:0 0 24px">
    <a href="${this.trackingUrl(order)}"
       style="background:#18181b;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600">
      Track your order
    </a>
  </p>

  <table width="100%" style="border-collapse:collapse;font-size:15px">
    ${rows}
    <tr><td colspan="2" style="border-top:1px solid #e4e4e7;padding-top:8px"></td></tr>
    ${line("Subtotal", order.subtotal)}
    ${line("Delivery", order.deliveryFee)}
    ${line("Service charge", order.serviceCharge)}
    <tr><td style="padding-top:6px;font-weight:700">Total</td>
        <td align="right" style="padding-top:6px;font-weight:700">${this.money(order.total)}</td></tr>
  </table>

  <p style="margin:24px 0 0;color:#71717a;font-size:13px">
    ${order.fulfillmentType === "DELIVERY" ? "We'll let you know when it's on its way." : "We'll let you know when it's ready to collect."}
    You can follow it any time on the tracking page above.
  </p>
</div>`.trim();
  }

  /** Customer-supplied names and notes land in this HTML. */
  private esc(v: unknown): string {
    return String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
