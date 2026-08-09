// Emailed customer receipts for in-person (card terminal / Tap to Pay) orders.
//
// WHY THIS EXISTS: Apple's Tap to Pay on iPhone App Review checklist (5.10)
// requires that — approved or declined — it must be possible to send the
// customer a confidential digital receipt (SMS, email, QR or share sheet).
// Until now an in-person order only produced a PAPER receipt via the
// Bluetooth/LAN printer, which doesn't satisfy that.
//
// Email over SMS: SMS costs ~7p/segment out of the tenant's prepaid SMS
// Wallet and fails once that balance runs dry — mid-service, silently, on a
// compliance-required feature. Email has no per-message cost and no balance
// to exhaust. SMS can be added later as a second option (the wallet plumbing
// already exists) without changing this service's shape.
//
// "Confidential" is why we never echo the card number, and why the receipt
// is addressed only to the address staff were given at the counter.

import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { EmailService } from "../../infrastructure/email/email.service";

/** Money is Prisma Decimal on the way in — normalise before formatting. */
function money(v: unknown): number {
  return Number(v ?? 0);
}

function gbp(v: unknown): string {
  return `£${money(v).toFixed(2)}`;
}

/** Minimal HTML escape — item names and notes are operator/customer text. */
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

@Injectable()
export class ReceiptEmailService {
  private readonly logger = new Logger(ReceiptEmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /** Email a receipt for one order. Tenant-scoped: an order id from another
   *  tenant resolves to nothing and 404s rather than leaking a receipt. */
  async sendOrderReceipt(args: {
    tenantId: string;
    orderId: string;
    to: string;
  }): Promise<{ sent: true }> {
    const order = await this.prisma.order.findFirst({
      where: { id: args.orderId, tenantId: args.tenantId },
      select: {
        id: true,
        displayId: true,
        orderNumber: true,
        createdAt: true,
        customerName: true,
        fulfillmentType: true,
        subtotal: true,
        taxAmount: true,
        serviceCharge: true,
        tipAmount: true,
        deliveryFee: true,
        discount: true,
        total: true,
        paymentMethod: true,
        paymentStatus: true,
        items: {
          select: { name: true, quantity: true, totalPrice: true, modifiers: true },
        },
        location: { select: { name: true, phone: true, addressLine1: true, addressLine2: true } },
        brand: { select: { name: true, logoUrl: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    const shopName = order.brand?.name ?? order.location?.name ?? "Order Hub";
    const reference = order.displayId ?? order.orderNumber ?? order.id.slice(-6).toUpperCase();

    await this.email.send({
      to: args.to,
      subject: `Your receipt from ${shopName} — ${reference}`,
      html: this.renderHtml(order, shopName, String(reference)),
      text: this.renderText(order, shopName, String(reference)),
    });

    this.logger.log(`Receipt emailed for order ${order.id} → ${args.to}`);
    return { sent: true };
  }

  private renderHtml(order: any, shopName: string, reference: string): string {
    const addressLines = [order.location?.addressLine1, order.location?.addressLine2]
      .filter(Boolean)
      .map((l: string) => esc(l))
      .join(", ");

    const itemRows = (order.items ?? [])
      .map((i: any) => {
        const mods: string[] = Array.isArray(i.modifiers)
          ? i.modifiers
              .map((m: any) => (typeof m === "string" ? m : (m?.name ?? "")))
              .filter(Boolean)
          : [];
        const modLine = mods.length
          ? `<div style="color:#71717a;font-size:12px;padding-left:2px">+ ${esc(mods.join(", "))}</div>`
          : "";
        return `
          <tr>
            <td style="padding:8px 0;border-bottom:1px solid #f4f4f5;vertical-align:top">
              <strong>${i.quantity}×</strong> ${esc(i.name)}
              ${modLine}
            </td>
            <td style="padding:8px 0;border-bottom:1px solid #f4f4f5;text-align:right;vertical-align:top;white-space:nowrap">
              ${gbp(i.totalPrice)}
            </td>
          </tr>`;
      })
      .join("");

    // Only render the lines that actually carry a value, so a simple
    // counter sale doesn't show a wall of "£0.00" rows.
    const optional = (label: string, value: unknown, negative = false) =>
      money(value) > 0
        ? `<tr>
             <td style="padding:2px 0;color:#52525b">${label}</td>
             <td style="padding:2px 0;text-align:right">${negative ? "−" : ""}${gbp(value)}</td>
           </tr>`
        : "";

    const paid = order.paymentStatus === "PAID";

    return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#18181b">
  <div style="text-align:center;margin-bottom:20px">
    ${
      order.brand?.logoUrl
        ? `<img src="${esc(order.brand.logoUrl)}" alt="${esc(shopName)}" style="max-height:56px;margin-bottom:10px" />`
        : ""
    }
    <h1 style="font-size:20px;margin:0">${esc(shopName)}</h1>
    ${addressLines ? `<p style="margin:4px 0 0;color:#71717a;font-size:13px">${addressLines}</p>` : ""}
    ${order.location?.phone ? `<p style="margin:2px 0 0;color:#71717a;font-size:13px">${esc(order.location.phone)}</p>` : ""}
  </div>

  <div style="background:${paid ? "#ecfdf5" : "#fef2f2"};color:${paid ? "#047857" : "#b91c1c"};
              text-align:center;font-weight:600;border-radius:8px;padding:10px;margin-bottom:20px">
    ${paid ? "Paid" : "Not paid"} · ${gbp(order.total)}
  </div>

  <p style="margin:0 0 16px;color:#52525b;font-size:13px">
    Order <strong>${esc(reference)}</strong><br />
    ${new Date(order.createdAt).toLocaleString("en-GB", { timeZone: "Europe/London" })}
    ${order.customerName ? `<br />${esc(order.customerName)}` : ""}
  </p>

  <table style="width:100%;border-collapse:collapse;font-size:14px">${itemRows}</table>

  <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">
    <tr>
      <td style="padding:2px 0;color:#52525b">Subtotal</td>
      <td style="padding:2px 0;text-align:right">${gbp(order.subtotal)}</td>
    </tr>
    ${optional("Discount", order.discount, true)}
    ${optional("Delivery", order.deliveryFee)}
    ${optional("Service charge", order.serviceCharge)}
    ${optional("Tip", order.tipAmount)}
    ${optional("Tax", order.taxAmount)}
    <tr>
      <td style="padding:10px 0 0;font-weight:700;border-top:2px solid #18181b">Total</td>
      <td style="padding:10px 0 0;text-align:right;font-weight:700;border-top:2px solid #18181b">
        ${gbp(order.total)}
      </td>
    </tr>
  </table>

  <p style="margin:24px 0 0;color:#a1a1aa;font-size:11px;text-align:center">
    This receipt was sent by ${esc(shopName)}. Card details are never included.
  </p>
</div>`.trim();
  }

  private renderText(order: any, shopName: string, reference: string): string {
    const lines = [
      shopName,
      `Order ${reference}`,
      new Date(order.createdAt).toLocaleString("en-GB", { timeZone: "Europe/London" }),
      "",
      ...(order.items ?? []).map((i: any) => `${i.quantity}x ${i.name}  ${gbp(i.totalPrice)}`),
      "",
      `Subtotal: ${gbp(order.subtotal)}`,
    ];
    if (money(order.discount) > 0) lines.push(`Discount: -${gbp(order.discount)}`);
    if (money(order.deliveryFee) > 0) lines.push(`Delivery: ${gbp(order.deliveryFee)}`);
    if (money(order.serviceCharge) > 0) lines.push(`Service charge: ${gbp(order.serviceCharge)}`);
    if (money(order.tipAmount) > 0) lines.push(`Tip: ${gbp(order.tipAmount)}`);
    if (money(order.taxAmount) > 0) lines.push(`Tax: ${gbp(order.taxAmount)}`);
    lines.push(`TOTAL: ${gbp(order.total)}`);
    lines.push(order.paymentStatus === "PAID" ? "PAID" : "NOT PAID");
    return lines.join("\n");
  }
}
