import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { formatMoney, renderPoweredBy } from "@orderhub/shared";
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
/** How many orders one sweep looks at. The window is small, so this is
 *  generous enough that already-emailed orders cannot crowd out new ones. */
const SCAN = 200;
/** Belt and braces against a runaway sweep burning the daily allowance. */
const PER_SWEEP = 25;

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
        },
        orderBy: { createdAt: "asc" },
        // Scan the window and skip the already-sent in code. Filtering the
        // marker in SQL means a JSON path predicate whose null semantics
        // differ between "key absent" and "value null" — and getting that
        // subtly wrong sends a customer a second confirmation.
        take: SCAN,
        include: {
          // `modifiers` is a Json COLUMN on OrderItem, not a relation, so it
          // arrives with the row. Trying to `include` it threw on every
          // sweep — and the `as any` that used to sit here is why the
          // compiler did not say so.
          items: true,
          location: {
            select: {
              name: true,
              onlineOrderingSlug: true,
              slug: true,
              // Money without a symbol is ambiguous, and the currency decides
              // the decimals too — a dinar is 3, not 2.
              currency: true,
              phone: true,
              // The email's header, and where to collect from.
              logoUrl: true,
              addressLine1: true,
              city: true,
              postcode: true,
              timezone: true,
            },
          },
          brand: { select: { name: true, logoUrl: true } },
          // Both address sources. Without these the fallbacks below read
          // undefined for ever, which is how the first live order reached
          // the kitchen with no email sent.
          customerAccount: { select: { email: true } },
          customer: { select: { email: true } },
        },
      });
      if (orders.length === 0) return;

      // One count for the batch. Resend's free plan stops dead at its daily
      // limit, and a customer silently not getting a confirmation looks
      // identical to the order not existing.
      const cap = Number(this.cfg<number>("dailyCap") ?? 100);
      const warnAt = Number(this.cfg<number>("capWarnAt") ?? 80);
      let sentToday = await this.countToday();
      let sentNow = 0;

      for (const order of orders as any[]) {
        if (sentNow >= PER_SWEEP) break;
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
            fromName: this.shopName(order),
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
        sentNow += 1;
        // Success was silent, so a clean log could not tell "it sent" from
        // "it never ran". The address is the part worth being able to check
        // when a customer says nothing arrived, so it is masked, not omitted.
        this.logger.log(
          `Order confirmation sent for ${this.reference(order)} to ${this.mask(to)} ` +
            `(${sentToday}/${cap} today)`,
        );
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

  /**
   * Where to send it, most trustworthy first.
   *
   * Online ordering requires a sign-in, so `customerAccount.email` is the
   * address the customer proved they own — it is non-null on that model and
   * is the right default. The CRM record comes next. The checkout form's
   * email field is LAST because it is optional and routinely left blank,
   * which is why relying on it sent nothing at all.
   */
  private addressFor(order: any): string | null {
    for (const raw of [
      order?.customerAccount?.email,
      order?.customer?.email,
      order?.customerInfo?.email,
    ]) {
      const email = String(raw ?? "").trim();
      if (email.includes("@")) return email;
    }
    return null;
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

  private money(v: unknown, order: any): string {
    return formatMoney(Number(v ?? 0), order?.location?.currency ?? "GBP");
  }

  /** Where it is going, or that it is being collected. */
  private whereLine(order: any): string {
    if (order.fulfillmentType !== "DELIVERY") {
      return `Collection from ${this.esc(order.location?.name ?? "the shop")}`;
    }
    const a = order.deliveryAddress ?? {};
    const parts = [a.line1, a.line2, a.city, a.postcode].filter(Boolean);
    return parts.length
      ? `Delivering to ${this.esc(parts.join(", "))}`
      : "Delivering to the address you gave at checkout";
  }

  private webBase(): string {
    return String(this.config?.get<string>("app.webUrl") ?? "https://www.orderhubsolutions.com").replace(/\/+$/, "");
  }

  /** Absolute URL for an image — logos are sometimes stored as site paths. */
  private img(u: unknown): string {
    const v = String(u ?? "").trim();
    if (!v) return "";
    return this.esc(v.startsWith("/") && !v.startsWith("//") ? `${this.webBase()}${v}` : v);
  }

  /** "Today, 7:30pm" style label for a scheduled order, in the shop's zone. */
  private whenLabel(order: any): string | null {
    if (!order.scheduledFor) return null;
    try {
      return new Date(order.scheduledFor).toLocaleString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZone: order.location?.timezone || "Europe/London",
      });
    } catch {
      return null;
    }
  }

  private firstName(order: any): string {
    const raw = String(order.customerInfo?.name ?? order.customerName ?? "").trim();
    return raw.split(/\s+/)[0] ?? "";
  }

  private body(order: any): string {
    const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
    const ink = "#18181b";
    const muted = "#71717a";
    const accent = "#16a34a";
    const isDelivery = order.fulfillmentType === "DELIVERY";
    const shop = this.esc(this.shopName(order));
    const logo = this.img(order.brand?.logoUrl ?? order.location?.logoUrl);
    const first = this.esc(this.firstName(order));
    const when = this.whenLabel(order);

    const rows = (order.items ?? [])
      .map((i: any) => {
        const mods = (i.modifiers ?? [])
          .map((m: any) => m?.name)
          .filter(Boolean)
          .join(", ");
        // The POS already folds the choices into the item name on some
        // channels, so printing them again gave every line twice.
        const alreadyNamed =
          !!mods && String(i.name ?? "").toLowerCase().includes(mods.toLowerCase());
        const showMods = mods && !alreadyNamed;
        return `<tr>
<td width="36" valign="top" style="padding:12px 0;border-bottom:1px solid #f4f4f5;">
  <div style="display:inline-block;min-width:24px;padding:3px 6px;border-radius:6px;background:#f4f4f5;font-family:${FONT};font-size:13px;font-weight:700;color:${ink};text-align:center;">${this.esc(i.quantity)}×</div>
</td>
<td valign="top" style="padding:12px 8px;border-bottom:1px solid #f4f4f5;font-family:${FONT};font-size:15px;color:${ink};">
  <div style="font-weight:600;">${this.esc(i.name)}</div>
  ${showMods ? `<div style="margin-top:2px;font-size:13px;line-height:1.45;color:${muted};">${this.esc(mods)}</div>` : ""}
</td>
<td valign="top" align="right" style="padding:12px 0;border-bottom:1px solid #f4f4f5;font-family:${FONT};font-size:15px;color:${ink};white-space:nowrap;">${this.money(i.totalPrice, order)}</td>
</tr>`;
      })
      .join("");

    const line = (label: string, value: unknown, negative = false) =>
      Number(value ?? 0) > 0
        ? `<tr><td style="padding:3px 0;font-family:${FONT};font-size:14px;color:${muted};">${label}</td><td align="right" style="padding:3px 0;font-family:${FONT};font-size:14px;color:${ink};">${negative ? "−" : ""}${this.money(value, order)}</td></tr>`
        : "";

    const where = this.whereLine(order);
    const phone = order.location?.phone ? this.esc(order.location.phone) : "";
    const collectAddress = !isDelivery
      ? [order.location?.addressLine1, order.location?.city, order.location?.postcode].filter(Boolean).map((x: any) => this.esc(x)).join(", ")
      : "";

    const powered = renderPoweredBy({
      url: `${this.webBase()}/?utm_source=email&utm_medium=powered_by&utm_campaign=order_confirmation`,
      logoUrl: `${this.webBase()}/email/orderhub-logo.png`,
    });

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Order confirmed</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Order ${this.esc(this.reference(order))} is confirmed — track it any time.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f5" style="background:#f4f4f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;">

<tr><td align="center" style="padding:28px 32px 8px 32px;font-family:${FONT};">
  ${logo ? `<img src="${logo}" alt="${shop}" height="64" style="display:block;margin:0 auto 10px auto;height:64px;max-width:200px;width:auto;border:0;">` : ""}
  <div style="font-size:15px;font-weight:700;color:${ink};">${shop}</div>
</td></tr>

<tr><td align="center" style="padding:20px 32px 4px 32px;font-family:${FONT};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
    <td width="56" height="56" align="center" valign="middle" bgcolor="${accent}" style="width:56px;height:56px;border-radius:28px;background:${accent};color:#ffffff;font-size:28px;font-weight:700;line-height:56px;">&#10003;</td>
  </tr></table>
  <h1 style="margin:16px 0 6px 0;font-size:26px;line-height:1.2;font-weight:800;color:${ink};">Order confirmed</h1>
  <p style="margin:0;font-size:16px;line-height:1.5;color:${muted};">Thanks${first ? ` ${first}` : ""}, we've got your order and the kitchen is on it.</p>
</td></tr>

<tr><td align="center" style="padding:18px 32px 6px 32px;font-family:${FONT};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
    <td style="padding:8px 14px;border-radius:999px;background:#f4f4f5;font-size:14px;color:${ink};">Order <b>${this.esc(this.reference(order))}</b></td>
    <td width="8"></td>
    <td style="padding:8px 14px;border-radius:999px;background:#f4f4f5;font-size:14px;color:${ink};">${isDelivery ? "Delivery" : "Collection"} · ${when ? this.esc(when) : "ASAP"}</td>
  </tr></table>
</td></tr>

<tr><td align="center" style="padding:20px 32px 28px 32px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
    <td bgcolor="${ink}" style="border-radius:10px;background:${ink};">
      <a href="${this.trackingUrl(order)}" target="_blank" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">Track your order</a>
    </td>
  </tr></table>
</td></tr>

<tr><td style="padding:0 32px;">
  <div style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${muted};padding-bottom:4px;border-bottom:1px solid #e4e4e7;">Your order</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;">
    ${line("Subtotal", order.subtotal)}
    ${line("Delivery", order.deliveryFee)}
    ${line("Service charge", order.serviceCharge)}
    ${line("Discount", order.discount, true)}
    ${line("Tip", order.tipAmount)}
    <tr><td style="padding:10px 0 0 0;font-family:${FONT};font-size:17px;font-weight:800;color:${ink};border-top:1px solid #e4e4e7;">Total</td>
        <td align="right" style="padding:10px 0 0 0;font-family:${FONT};font-size:17px;font-weight:800;color:${ink};border-top:1px solid #e4e4e7;">${this.money(order.total, order)}</td></tr>
  </table>
</td></tr>

<tr><td style="padding:24px 32px 8px 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fafafa" style="background:#fafafa;border:1px solid #f0f0f0;border-radius:12px;">
    <tr><td style="padding:16px 18px;font-family:${FONT};font-size:14px;line-height:1.55;color:${ink};">
      <div style="font-size:12px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${muted};margin-bottom:4px;">${isDelivery ? "Delivering to" : "Collect from"}</div>
      <div>${isDelivery ? where.replace(/^Delivering to /, "") : `${this.esc(order.location?.name ?? "the shop")}${collectAddress ? `<br>${collectAddress}` : ""}`}</div>
      ${phone ? `<div style="margin-top:10px;color:${muted};">Questions about your order? Call ${shop} on <a href="tel:${phone.replace(/\s+/g, "")}" style="color:${ink};font-weight:600;text-decoration:none;">${phone}</a></div>` : ""}
    </td></tr>
  </table>
</td></tr>

<tr><td align="center" style="padding:16px 32px 18px 32px;font-family:${FONT};font-size:13px;line-height:1.5;color:${muted};">
  ${isDelivery ? "We'll let you know when it's on its way." : "We'll let you know when it's ready to collect."}
  You can follow it any time on the tracking page.
</td></tr>

${powered}
</table>
</td></tr></table>
</body></html>`;
  }

  /** Enough of an address to recognise, not enough to be a log of emails. */
  private mask(email: string): string {
    const [user = "", domain = ""] = email.split("@");
    const head = user.slice(0, 2);
    return `${head}${"*".repeat(Math.max(1, user.length - 2))}@${domain}`;
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
