// Eat For Less — the weekly statement a shop gets every Monday.
//
// One week (Mon–Sun, UK time) of a shop's Eat For Less orders: what customers
// paid, our commission, sponsored-listing spend and what was taken back, and
// what that leaves the shop. Downloadable as a PDF from OrderHub, emailed on
// demand, and emailed automatically on Monday morning for last week.
//
// Money already moved through Stripe as each order was paid (our fee is the
// application fee on the shop's own account), so a statement is a record,
// not a bill: there is nothing to pay.

import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { EmailService } from "../../infrastructure/email/email.service";
import { EflAdsService } from "./efl-ads.service";
import { londonDateKey, londonWeekStart, nextWeekStart, weekStartFromKey } from "./efl-ads-rules";
import { eflCommissionPence } from "./efl-rules";

const COMPANY_LINE =
  "Eat For Less Ltd · Company no. 17543774 · 5 Sunningdale Drive, Washington, NE37 2LL · hello@eatforless.co.uk";

export type StatementLine = {
  orderId: string;
  ref: string;
  placedAt: string;
  fulfillment: "Delivery" | "Collection";
  food: number;
  deliveryFee: number;
  tip: number;
  customerPaid: number;
  commission: number;
  adRecovered: number;
  toShop: number;
};

export type Statement = {
  listingId: string;
  locationId: string;
  shopName: string;
  week: string; // Monday, "2026-10-26"
  weekLabel: string; // "26 Oct – 1 Nov 2026"
  orders: number;
  customerPaid: number;
  food: number;
  deliveryFees: number;
  tips: number;
  commission: number;
  ads: { shows: number; taps: number; spent: number; ordersFromAds: number; recovered: number; stillOwed: number };
  toShop: number;
  refundedOrders: number;
  lines: StatementLine[];
};

const money = (n: number) => `£${n.toFixed(2)}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class EflStatementsService {
  private readonly logger = new Logger(EflStatementsService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ads: EflAdsService,
    @Optional() private readonly email?: EmailService,
  ) {}

  /** Monday mornings, last week's statement to every shop that traded or advertised. */
  @Cron("0 0 7 * * 1", { timeZone: "Europe/London" })
  async mondayRun() {
    if (process.env.EFL_STATEMENTS_ENABLED === "false" || this.running) return;
    this.running = true;
    try {
      const lastWeek = londonWeekStart(new Date(londonWeekStart(new Date()).getTime() - 86_400_000));
      const sent = await this.sendWeek(lastWeek);
      this.logger.log(`EFL statements for ${londonDateKey(lastWeek)}: ${sent} sent`);
    } catch (e) {
      this.logger.error(`EFL statements run failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Email the week's statement to every shop with something on it, once each. */
  async sendWeek(weekStart: Date): Promise<number> {
    const end = nextWeekStart(weekStart);
    const listings = await this.prisma.eflListing.findMany({ select: { id: true, locationId: true } });
    let sent = 0;
    for (const l of listings) {
      const already = await this.prisma.eflStatementSend.findUnique({
        where: { listingId_weekStart: { listingId: l.id, weekStart } },
      });
      if (already) continue;
      const [orders, taps] = await Promise.all([
        this.prisma.order.count({
          where: { locationId: l.locationId, orderSource: "EAT_FOR_LESS", createdAt: { gte: weekStart, lt: end } },
        }),
        this.prisma.eflAdTap.count({ where: { listingId: l.id, createdAt: { gte: weekStart, lt: end } } }),
      ]);
      if (!orders && !taps) continue;
      try {
        await this.emailStatement(l.locationId, londonDateKey(weekStart));
        sent++;
      } catch (e) {
        this.logger.warn(`Statement for ${l.locationId} not sent: ${(e as Error).message}`);
      }
    }
    return sent;
  }

  // ── Building one ──────────────────────────────────────────────────────

  async build(locationId: string, week: string): Promise<Statement> {
    const weekStart = weekStartFromKey(week);
    if (!weekStart) throw new BadRequestException("A week is named by its Monday, e.g. 2026-10-26.");
    const end = nextWeekStart(weekStart);
    const listing = await this.prisma.eflListing.findUnique({
      where: { locationId },
      select: { id: true, locationId: true, location: { select: { name: true, brand: { select: { name: true } } } } },
    });
    if (!listing) throw new NotFoundException("This shop isn't on Eat For Less");

    const [rows, refundedOrders, adWeek, owed] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          locationId,
          orderSource: "EAT_FOR_LESS",
          paymentStatus: "PAID" as any,
          createdAt: { gte: weekStart, lt: end },
        },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          displayId: true,
          orderNumber: true,
          createdAt: true,
          fulfillmentType: true,
          subtotal: true,
          discount: true,
          deliveryFee: true,
          tipAmount: true,
          total: true,
          eflCommissionPercent: true,
          eflAdRecovered: true,
        },
      }),
      this.prisma.order.count({
        where: {
          locationId,
          orderSource: "EAT_FOR_LESS",
          paymentStatus: { in: ["REFUNDED", "PARTIALLY_REFUNDED"] as any },
          createdAt: { gte: weekStart, lt: end },
        },
      }),
      this.ads.weekStats(listing.id, weekStart),
      this.ads.owedPence(listing.id, locationId),
    ]);

    const lines: StatementLine[] = rows.map((o) => {
      const food = Math.max(0, Number(o.subtotal) - Number(o.discount ?? 0));
      const commission = eflCommissionPence(o) / 100;
      const adRecovered = Number(o.eflAdRecovered ?? 0);
      const customerPaid = Number(o.total);
      return {
        orderId: o.id,
        ref: `#${o.displayId ?? o.orderNumber ?? o.id.slice(-6)}`,
        placedAt: o.createdAt.toISOString(),
        fulfillment: o.fulfillmentType === "DELIVERY" ? "Delivery" : "Collection",
        food: r2(food),
        deliveryFee: r2(Number(o.deliveryFee ?? 0)),
        tip: r2(Number(o.tipAmount ?? 0)),
        customerPaid: r2(customerPaid),
        commission: r2(commission),
        adRecovered: r2(adRecovered),
        toShop: r2(customerPaid - commission - adRecovered),
      };
    });
    const sum = (k: keyof StatementLine) => r2(lines.reduce((t, l) => t + (l[k] as number), 0));

    return {
      listingId: listing.id,
      locationId,
      shopName: listing.location?.brand?.name ?? listing.location?.name ?? "Your shop",
      week,
      weekLabel: weekLabel(weekStart, end),
      orders: lines.length,
      customerPaid: sum("customerPaid"),
      food: sum("food"),
      deliveryFees: sum("deliveryFee"),
      tips: sum("tip"),
      commission: sum("commission"),
      ads: {
        shows: adWeek.shows,
        taps: adWeek.taps,
        spent: adWeek.spent,
        ordersFromAds: adWeek.orders,
        recovered: sum("adRecovered"),
        stillOwed: owed / 100,
      },
      toShop: sum("toShop"),
      refundedOrders,
      lines,
    };
  }

  /** The last `weeks` weeks for one shop, newest first, as summaries. */
  async list(locationId: string, weeks = 12) {
    const out: Array<Omit<Statement, "lines">> = [];
    let start = londonWeekStart(new Date());
    for (let i = 0; i < weeks; i++) {
      const { lines: _lines, ...summary } = await this.build(locationId, londonDateKey(start));
      out.push(summary);
      start = londonWeekStart(new Date(start.getTime() - 86_400_000));
    }
    return out;
  }

  /** Every shop's statement for one week, for the Console. */
  async adminWeek(week: string) {
    const listings = await this.prisma.eflListing.findMany({ select: { locationId: true } });
    const all = await Promise.all(listings.map((l) => this.build(l.locationId, week)));
    const active = all.filter((s) => s.orders || s.ads.taps).map(({ lines: _lines, ...s }) => s);
    const total = (f: (s: (typeof active)[number]) => number) => r2(active.reduce((t, s) => t + f(s), 0));
    return {
      week,
      // From the week itself, not a shop: with no shops there is no row to borrow it from.
      weekLabel: (() => {
        const start = weekStartFromKey(week);
        return start ? weekLabel(start, nextWeekStart(start)) : week;
      })(),
      shops: active,
      totals: {
        orders: active.reduce((t, s) => t + s.orders, 0),
        customerPaid: total((s) => s.customerPaid),
        commission: total((s) => s.commission),
        adSpent: total((s) => s.ads.spent),
        adRecovered: total((s) => s.ads.recovered),
        toShops: total((s) => s.toShop),
      },
    };
  }

  // ── Email ─────────────────────────────────────────────────────────────

  /** Where a shop's statements go: its own setting, else the account's email. */
  async recipientFor(locationId: string): Promise<string | null> {
    const row = await this.prisma.eflListing.findUnique({
      where: { locationId },
      select: { statementEmail: true, location: { select: { brand: { select: { tenantId: true } } } } },
    });
    if (row?.statementEmail) return row.statementEmail;
    const tenantId = row?.location?.brand?.tenantId;
    if (!tenantId) return null;
    // The account's owner: the person who signed the shop up.
    const owner = await this.prisma.user.findFirst({
      where: { tenantId, isActive: true, role: { in: ["TENANT_OWNER", "OWNER"] as any } },
      orderBy: { createdAt: "asc" },
      select: { email: true },
    });
    return owner?.email ?? null;
  }

  async emailStatement(locationId: string, week: string, to?: string | null) {
    if (!this.email) throw new BadRequestException("Email isn't set up.");
    const statement = await this.build(locationId, week);
    const recipient = to?.trim() || (await this.recipientFor(locationId));
    if (!recipient) throw new BadRequestException("Add an email for statements first.");
    const pdf = await this.pdf(statement);
    await this.email.send({
      to: recipient,
      subject: `Your Eat For Less statement · ${statement.weekLabel}`,
      fromAddress: process.env.EFL_EMAIL_FROM || "Eat For Less <hello@eatforless.co.uk>",
      replyTo: "hello@eatforless.co.uk",
      html: emailHtml(statement),
      attachments: [{ filename: `eat-for-less-${statement.week}.pdf`, content: Buffer.from(pdf).toString("base64") }],
    });
    await this.prisma.eflStatementSend.upsert({
      where: { listingId_weekStart: { listingId: statement.listingId, weekStart: weekStartFromKey(week)! } },
      create: { listingId: statement.listingId, weekStart: weekStartFromKey(week)!, sentTo: recipient },
      update: { sentTo: recipient, sentAt: new Date() },
    });
    return { sentTo: recipient };
  }

  // ── PDF ───────────────────────────────────────────────────────────────

  async pdf(s: Statement): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.setTitle(`Eat For Less statement ${s.week}`);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const ink = rgb(0.043, 0.043, 0.043);
    const grey = rgb(0.4, 0.4, 0.4);
    const lime = rgb(0.83, 1, 0.25);
    const W = 595.28;
    const H = 841.89;
    const M = 40;

    let page = doc.addPage([W, H]);
    let y = H - M;
    const text = (p: PDFPage, t: string, x: number, yy: number, size = 10, f: PDFFont = font, color = ink) =>
      p.drawText(t, { x, y: yy, size, font: f, color });
    const right = (p: PDFPage, t: string, xRight: number, yy: number, size = 10, f: PDFFont = font, color = ink) =>
      p.drawText(t, { x: xRight - f.widthOfTextAtSize(t, size), y: yy, size, font: f, color });

    // Header band
    page.drawRectangle({ x: 0, y: H - 96, width: W, height: 96, color: lime });
    text(page, "eat for less", M, H - 52, 24, bold);
    text(page, "Weekly statement", M, H - 74, 11, font);
    right(page, s.shopName, W - M, H - 52, 13, bold);
    right(page, s.weekLabel, W - M, H - 72, 11);
    y = H - 130;

    // Summary
    const rows: Array<[string, string, boolean?]> = [
      ["Orders", String(s.orders)],
      ["Customers paid", money(s.customerPaid)],
      ["   of which food (after discounts)", money(s.food)],
      ["   of which delivery fees", money(s.deliveryFees)],
      ["   of which tips", money(s.tips)],
      ["Eat For Less commission (on food only)", `- ${money(s.commission)}`],
      ["Sponsored listing taken back", `- ${money(s.ads.recovered)}`],
      ["Yours from Eat For Less this week", money(s.toShop), true],
    ];
    for (const [label, value, strong] of rows) {
      if (strong) page.drawLine({ start: { x: M, y: y + 12 }, end: { x: W - M, y: y + 12 }, thickness: 0.8, color: ink });
      text(page, label, M, y, strong ? 12 : 10.5, strong ? bold : font);
      right(page, value, W - M, y, strong ? 12 : 10.5, strong ? bold : font);
      y -= strong ? 26 : 18;
    }
    text(
      page,
      "Paid into your own Stripe account as each order was paid. Card fees are charged by Stripe on your account and aren't shown here.",
      M,
      y,
      8.5,
      font,
      grey,
    );
    y -= 28;

    // Ads
    text(page, "Sponsored listing", M, y, 12, bold);
    y -= 18;
    const ad = s.ads;
    for (const [label, value] of [
      ["Shown", String(ad.shows)],
      ["Taps", String(ad.taps)],
      ["Orders from ads", String(ad.ordersFromAds)],
      ["Spent this week", money(ad.spent)],
      ["Still to be taken back (from next orders)", money(ad.stillOwed)],
    ]) {
      text(page, label!, M, y, 10.5);
      right(page, value!, W - M, y, 10.5);
      y -= 16;
    }
    y -= 18;

    // Orders table
    const cols = [
      { t: "Order", x: M, align: "l" },
      { t: "Date", x: M + 78, align: "l" },
      { t: "Type", x: M + 168, align: "l" },
      { t: "Paid", x: M + 300, align: "r" },
      { t: "Commission", x: M + 375, align: "r" },
      { t: "Ads", x: M + 430, align: "r" },
      { t: "Yours", x: W - M, align: "r" },
    ] as const;
    const header = (p: PDFPage, yy: number) => {
      p.drawRectangle({ x: M - 4, y: yy - 5, width: W - 2 * M + 8, height: 18, color: rgb(0.95, 0.95, 0.95) });
      for (const c of cols) (c.align === "l" ? text : right)(p, c.t, c.x, yy, 9, bold);
    };
    text(page, "Orders", M, y, 12, bold);
    y -= 22;
    header(page, y);
    y -= 18;
    if (!s.lines.length) {
      text(page, "No paid Eat For Less orders this week.", M, y, 10, font, grey);
      y -= 16;
    }
    for (const l of s.lines) {
      if (y < M + 40) {
        page = doc.addPage([W, H]);
        y = H - M;
        header(page, y);
        y -= 18;
      }
      const when = new Date(l.placedAt).toLocaleString("en-GB", {
        timeZone: "Europe/London",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      const cells = [l.ref, when, l.fulfillment, money(l.customerPaid), money(l.commission), money(l.adRecovered), money(l.toShop)];
      cols.forEach((c, i) => (c.align === "l" ? text : right)(page, cells[i]!.slice(0, 18), c.x, y, 9));
      y -= 15;
    }
    if (s.refundedOrders) {
      y -= 6;
      text(page, `${s.refundedOrders} refunded order${s.refundedOrders === 1 ? "" : "s"} not included.`, M, y, 9, font, grey);
    }

    for (const p of doc.getPages()) text(p, COMPANY_LINE, M, 24, 7.5, font, grey);
    return doc.save();
  }
}

function weekLabel(start: Date, end: Date): string {
  const last = new Date(end.getTime() - 3600_000);
  const fmt = (d: Date, withYear: boolean) =>
    d.toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) });
  return `${fmt(start, false)} – ${fmt(last, true)}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function emailHtml(s: Statement): string {
  const row = (label: string, value: string, strong = false) =>
    `<tr><td style="padding:6px 0;color:#0B0B0B;${strong ? "font-weight:800;border-top:1px solid #0B0B0B;padding-top:10px" : ""}">${label}</td>` +
    `<td style="padding:6px 0;text-align:right;color:#0B0B0B;${strong ? "font-weight:800;border-top:1px solid #0B0B0B;padding-top:10px" : ""}">${value}</td></tr>`;
  return `<!doctype html><html><body style="margin:0;background:#F3F3F3;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden">
<tr><td style="background:#D4FF3F;padding:22px 24px"><div style="font-size:22px;font-weight:900;color:#0B0B0B">eat for less</div>
<div style="font-size:14px;color:#0B0B0B;margin-top:4px">Weekly statement · ${esc(s.weekLabel)}</div></td></tr>
<tr><td style="padding:22px 24px">
<p style="margin:0 0 14px;font-size:15px;color:#0B0B0B">Hi ${esc(s.shopName)}, here's your week on Eat For Less. The full statement is attached.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">
${row("Orders", String(s.orders))}
${row("Customers paid", money(s.customerPaid))}
${row("Commission (on food only)", `- ${money(s.commission)}`)}
${row("Sponsored listing taken back", `- ${money(s.ads.recovered)}`)}
${row("Yours this week", money(s.toShop), true)}
</table>
${s.ads.taps ? `<p style="margin:16px 0 0;font-size:13px;color:#5E5E5E">Ads: shown ${s.ads.shows} times, ${s.ads.taps} taps, ${s.ads.ordersFromAds} orders, ${money(s.ads.spent)} spent.</p>` : ""}
<p style="margin:16px 0 0;font-size:13px;color:#5E5E5E">This money was paid into your own Stripe account as each order was paid — there's nothing to pay us. Questions? Just reply.</p>
</td></tr>
<tr><td style="padding:14px 24px;background:#0B0B0B;color:#8C8C8C;font-size:11px">${esc(COMPANY_LINE)}</td></tr>
</table></td></tr></table></body></html>`;
}
