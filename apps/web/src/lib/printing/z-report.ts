// Z report: the day's takings on an 80mm ticket, printed from Analytics.
//
// Same figures as the screen, from the same /v1/analytics/overview response,
// with the charts left out. It reads what the page shows for the chosen dates
// and filters; printing it closes nothing and resets nothing.
//
// The sales block adds up on paper. Gross is before discounts, while the
// payment lines are what orders actually totalled, so "gross less discounts"
// lands short of the payments by whatever else was on the orders (tips, mostly).
// That gap gets its own line rather than leaving a cashier a sum that doesn't
// add up.

import type { AnalyticsOverview } from "../api/analytics.client";
import {
  centreOn,
  colsFor,
  commandsFor,
  line,
  moneyIn,
  needsRaster,
  padBetween,
  rasterTextLine,
  wrap,
} from "./bridge";

export interface ZReportInput {
  data: AnalyticsOverview;
  currency: string;
  /** The shop, or "All locations" / "3 locations". */
  scopeName: string;
  /** Only set when one shop is in view. */
  scopeAddress?: string | null;
  /** Null when not filtered. A filtered report must say so on the paper. */
  brandFilter?: string | null;
  channelFilter?: string | null;
  printedBy?: string | null;
  printedAt?: Date;
  includesTestOrders?: boolean;
  mixedCurrencies?: string[];
  channelLabel: (raw: string) => string;
  methodLabel: (raw: string) => string;
}

const when = (d: Date) => {
  const date = d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
};

export function buildZReport(
  input: ZReportInput,
  paperWidth: number = 80,
  star = false,
): Uint8Array {
  const { data, currency } = input;
  const { summary, paymentMix } = data;
  const cmd = commandsFor(star);
  const cols = colsFor(paperWidth);
  const dotWidth = cols * 12;
  const buf: number[] = [];
  const money = (n: number) => moneyIn(n, currency) || "0.00";

  const heading = (title: string) => {
    buf.push(...cmd.alignLeft, ...cmd.boldOn, ...cmd.reverseOn);
    line(buf, centreOn(title, cols));
    buf.push(...cmd.reverseOff, ...cmd.boldOff);
  };

  // Label on the left, figures on the right. A long name wraps above them, and
  // one the printer's font can't carry (Arabic, CJK) is drawn as pixels.
  const row = (label: string, right: string) => {
    if (!star && needsRaster(label)) {
      const raster = rasterTextLine(label, dotWidth, { fontPx: 24, right });
      if (raster) {
        buf.push(...raster.bytes);
        if (!raster.rightDrawn) line(buf, padBetween("", right, cols));
        return;
      }
    }
    const room = Math.max(8, cols - right.length - 1);
    const lines = wrap(label, room);
    const last = lines.pop() ?? "";
    for (const l of lines) line(buf, l);
    line(buf, padBetween(last, right, cols));
  };

  const keyRow = (label: string, right: string) => {
    buf.push(...cmd.boldOn, ...cmd.tallOn);
    row(label, right);
    buf.push(...cmd.tallOff, ...cmd.boldOff);
  };

  // Name, order count, amount: amounts in one column whatever their length.
  const countRows = (rows: Array<{ name: string; count: number; amount: number }>) => {
    const amounts = rows.map((r) => money(r.amount));
    const counts = rows.map((r) => String(r.count));
    const amountW = Math.max(...amounts.map((a) => a.length));
    const countW = Math.max(...counts.map((c) => c.length));
    rows.forEach((r, i) => {
      row(r.name, `${counts[i]!.padStart(countW)}  ${amounts[i]!.padStart(amountW)}`);
    });
  };

  const section = (
    title: string,
    rows: Array<{ name: string; count: number; amount: number }>,
    countName = "Orders",
  ) => {
    if (rows.length === 0) return;
    line(buf, "");
    heading(title);
    const widest = Math.max(...rows.map((r) => money(r.amount).length));
    line(buf, padBetween("", `${countName}  ${"Amount".padStart(widest)}`, cols));
    countRows(rows);
  };

  // ── Header ────────────────────────────────────────────────────────
  buf.push(...cmd.init, ...cmd.alignCenter, ...cmd.boldOn, ...cmd.doubleOn);
  line(buf, "Z REPORT");
  buf.push(...cmd.doubleOff);
  for (const l of wrap(input.scopeName, cols)) line(buf, l);
  buf.push(...cmd.boldOff);
  if (input.scopeAddress) {
    for (const l of wrap(input.scopeAddress, cols)) line(buf, l);
  }
  line(buf, "");

  // Anything that means these are not plain real takings goes above the numbers.
  const warnings = [
    input.includesTestOrders ? "INCLUDES TEST ORDERS" : null,
    input.mixedCurrencies?.length
      ? `MIXED CURRENCIES: ${input.mixedCurrencies.join(" + ")}`
      : null,
  ].filter((w): w is string => !!w);
  for (const w of warnings) {
    buf.push(...cmd.boldOn, ...cmd.reverseOn);
    line(buf, centreOn(w, cols));
    buf.push(...cmd.reverseOff, ...cmd.boldOff);
  }
  if (warnings.length) line(buf, "");

  buf.push(...cmd.alignLeft);
  row("From", when(new Date(data.window.from)));
  row("To", when(new Date(data.window.to)));
  row("Printed", when(input.printedAt ?? new Date()));
  if (input.printedBy) row("By", input.printedBy);
  if (input.brandFilter) {
    for (const l of wrap(`Brands: ${input.brandFilter}`, cols)) line(buf, l);
  }
  if (input.channelFilter) {
    for (const l of wrap(`Channels: ${input.channelFilter}`, cols)) line(buf, l);
  }

  // ── Sales ─────────────────────────────────────────────────────────
  const totalSales =
    paymentMix.cash.revenue +
    paymentMix.card.revenue +
    paymentMix.pending.revenue +
    paymentMix.other.revenue;
  const otherOnOrders = totalSales - (summary.grossRevenue - summary.discount);

  line(buf, "");
  heading("SALES");
  row("Items", money(summary.subtotal));
  if (summary.deliveryFees) row("Delivery fees", money(summary.deliveryFees));
  if (summary.serviceCharge) row("Service charge", money(summary.serviceCharge));
  if (summary.taxAmount) row("Tax", money(summary.taxAmount));
  buf.push(...cmd.boldOn);
  row("Gross sales", money(summary.grossRevenue));
  buf.push(...cmd.boldOff);
  if (summary.discount) row("Discounts", `-${money(summary.discount)}`);
  if (Math.abs(otherOnOrders) >= 0.01) {
    row("Tips and other", otherOnOrders < 0 ? `-${money(-otherOnOrders)}` : money(otherOnOrders));
  }
  keyRow("TOTAL SALES", money(totalSales));
  row("Net (excl. delivery, service)", money(summary.netRevenue));

  // ── Orders ────────────────────────────────────────────────────────
  line(buf, "");
  heading("ORDERS");
  row("Completed", String(summary.successfulOrders));
  row("Average order value", money(summary.avgOrderValue));
  row("Cancelled", String(summary.cancelledOrders));
  row("Failed", String(summary.failedOrders));
  row("Value lost", money(summary.cancelledRevenue + summary.failedRevenue));

  // ── Payments ──────────────────────────────────────────────────────
  line(buf, "");
  heading("PAYMENTS");
  keyRow(`CASH (${paymentMix.cash.orders})`, money(paymentMix.cash.revenue));
  keyRow(`CARD (${paymentMix.card.orders})`, money(paymentMix.card.revenue));
  if (paymentMix.pending.orders > 0) {
    row(`Not settled yet (${paymentMix.pending.orders})`, money(paymentMix.pending.revenue));
  }
  if (paymentMix.other.orders > 0) {
    row(`Other (${paymentMix.other.orders})`, money(paymentMix.other.revenue));
  }
  row(`Paid (${paymentMix.paidOrders})`, money(paymentMix.paidRevenue));
  row(`Outstanding (${paymentMix.unpaidOrders})`, money(paymentMix.unpaidRevenue));

  section(
    "PAYMENT METHODS",
    paymentMix.byMethod.map((m) => ({
      name: input.methodLabel(m.method),
      count: m.orders,
      amount: m.revenue,
    })),
  );

  // ── Where it came from ────────────────────────────────────────────
  section(
    "CHANNELS",
    data.byChannel.map((c) => ({
      name: input.channelLabel(c.name),
      count: c.orders,
      amount: c.revenue,
    })),
  );
  if (data.byBrand.length > 1) {
    section(
      "BRANDS",
      data.byBrand.map((b) => ({ name: b.name, count: b.orders, amount: b.revenue })),
    );
  }
  if (data.byLocation.length > 1) {
    section(
      "LOCATIONS",
      data.byLocation.map((l) => ({ name: l.name, count: l.orders, amount: l.revenue })),
    );
  }
  section(
    `TOP ${data.topProducts.length} ITEMS`,
    data.topProducts.map((p) => ({ name: p.name, count: p.quantity, amount: p.revenue })),
    "Qty",
  );

  line(buf, "");
  buf.push(...cmd.alignCenter);
  line(buf, "*** END OF REPORT ***");
  buf.push(0x0a, 0x0a, 0x0a, ...cmd.cut);
  return new Uint8Array(buf);
}
