// The emails a salon client gets: booked, moved, cancelled, the reminder,
// and the "time for a trim?" nudge.
//
// Table layout and inline styles only (what every mail client renders), and
// times in the SHOP's timezone — Render runs in UTC.

import { formatWhen, googleCalendarUrl } from "../reservations/reservation-emails";

export type SalonEmailKind = "confirmed" | "updated" | "cancelled" | "reminder" | "rebook" | "review";

export interface SalonEmailInput {
  kind: SalonEmailKind;
  shopName: string;
  logoUrl: string | null;
  address: string | null;
  shopPhone: string | null;
  timezone: string;
  currency: string;
  customerName: string;
  staffName: string | null;
  summary: string;
  startsAt: Date;
  durationMins: number;
  totalPrice: number;
  priceFrom: boolean;
  depositAmount: number;
  depositStatus: string;
  reference: string;
  patchTest: boolean;
  /** The guest's own page: view, move, cancel. */
  manageUrl: string | null;
  /** The booking page, for "book again". */
  bookUrl: string | null;
  /** The shop's Google review link (review email only). */
  reviewUrl?: string | null;
  cancellationWindowHours: number;
}

const ACCENT = "#f97316";

function esc(v: string): string {
  return v.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency || "GBP" }).format(n);
  } catch {
    return `£${n.toFixed(2)}`;
  }
}

function row(k: string, v: string): string {
  return `<tr><td style="padding:10px 0;border-top:1px solid #f4f4f5;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:.06em;width:110px;vertical-align:top">${k}</td><td style="padding:10px 0;border-top:1px solid #f4f4f5;color:#18181b;font-size:15px">${v}</td></tr>`;
}

function button(href: string, label: string, primary: boolean): string {
  return `<td style="padding:0 8px 8px 0"><a href="${esc(href)}" style="display:inline-block;padding:12px 18px;border-radius:12px;font-size:14px;font-weight:600;text-decoration:none;${
    primary ? `background:${ACCENT};color:#ffffff` : "background:#f4f4f5;color:#18181b"
  }">${esc(label)}</a></td>`;
}

export function salonEmail(o: SalonEmailInput): { subject: string; html: string; text: string } {
  const { day, time } = formatWhen(o.startsAt, o.timezone);
  const first = o.customerName.trim().split(/\s+/)[0] || o.customerName;
  const withWho = o.staffName ? ` with ${o.staffName}` : "";
  const cancelled = o.kind === "cancelled";
  const rebook = o.kind === "rebook";
  const review = o.kind === "review";

  const heading = {
    confirmed: "You're booked in",
    updated: "Your appointment has moved",
    cancelled: "Your appointment is cancelled",
    reminder: o.startsAt.getTime() - Date.now() < 26 * 3600_000 ? "See you tomorrow" : "See you soon",
    rebook: "Time for your next visit?",
    review: "Thanks for coming in",
  }[o.kind];
  const intro = {
    confirmed: `Thanks for booking with <strong>${esc(o.shopName)}</strong>.`,
    updated: `Your appointment at <strong>${esc(o.shopName)}</strong> has changed. Here are the new details.`,
    cancelled: `Your appointment at <strong>${esc(o.shopName)}</strong> has been cancelled.`,
    reminder: `A quick reminder of your appointment at <strong>${esc(o.shopName)}</strong>.`,
    rebook: `It's been a little while since your last visit to <strong>${esc(o.shopName)}</strong>. Grab your next slot before the week fills up.`,
    review: `Hope you're happy with your ${esc(o.summary.toLowerCase())}${o.staffName ? ` from ${esc(o.staffName)}` : ""}. If you've got a minute, a quick Google review really helps a small shop like ours.`,
  }[o.kind];
  const subject = {
    confirmed: `Booked — ${o.shopName}, ${day} at ${time}`,
    updated: `Appointment moved — ${o.shopName}, ${day} at ${time}`,
    cancelled: `Appointment cancelled — ${o.shopName}`,
    reminder: `Reminder — ${o.shopName}, ${day} at ${time}`,
    rebook: `Time for your next visit to ${o.shopName}?`,
    review: `How was your visit to ${o.shopName}?`,
  }[o.kind];

  const calUrl = googleCalendarUrl({
    title: `${o.summary} at ${o.shopName}`,
    startsAt: o.startsAt,
    durationMins: o.durationMins,
    location: o.address,
    details: `${o.summary}${withWho}. Reference ${o.reference}.${o.manageUrl ? ` Manage: ${o.manageUrl}` : ""}`,
  });

  const logo = o.logoUrl
    ? `<td style="padding-right:12px"><img src="${esc(o.logoUrl)}" width="44" height="44" alt="" style="display:block;border-radius:10px;background:#fff;object-fit:contain" /></td>`
    : "";

  const price = `${o.priceFrom ? "from " : ""}${money(o.totalPrice, o.currency)}`;
  const depositLine =
    o.depositAmount > 0 && (o.depositStatus === "PAID" || o.depositStatus === "APPLIED")
      ? `${money(o.depositAmount, o.currency)} deposit paid — comes off your bill`
      : o.depositAmount > 0 && o.depositStatus === "REFUNDED"
        ? `${money(o.depositAmount, o.currency)} deposit refunded to your card`
        : null;

  let buttons = "";
  if (review) {
    buttons = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr>${
      o.reviewUrl ? button(o.reviewUrl, "Leave a review", true) : ""
    }${o.bookUrl ? button(o.bookUrl, "Book your next visit", !o.reviewUrl) : ""}</tr></table>`;
  } else if (cancelled || rebook) {
    if (o.bookUrl) {
      buttons = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr>${button(o.bookUrl, rebook ? "Book now" : "Book again", true)}</tr></table>`;
    }
  } else {
    buttons = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr>${
      o.manageUrl ? button(o.manageUrl, "View or change", true) : ""
    }${button(calUrl, "Add to calendar", !o.manageUrl)}${
      o.shopPhone ? button(`tel:${o.shopPhone.replace(/[^\d+]/g, "")}`, "Call", false) : ""
    }</tr></table>`;
  }

  const details = rebook || review
    ? ""
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${cancelled ? "opacity:.6;" : ""}">
${row("When", `<strong>${esc(day)}</strong><br/><strong>${esc(time)}</strong>`)}
${row("What", esc(o.summary))}
${o.staffName ? row("With", esc(o.staffName)) : ""}
${row("Price", esc(price))}
${depositLine ? row("Deposit", esc(depositLine)) : ""}
${row("Reference", `<span style="font-family:Menlo,Consolas,monospace;font-weight:700;letter-spacing:.06em">${esc(o.reference)}</span>`)}
${o.address ? row("Where", esc(o.address)) : ""}
</table>`;

  const patch =
    o.patchTest && !cancelled && !rebook && !review
      ? `<p style="margin:16px 0 0;padding:12px 14px;border-radius:12px;background:#fff7ed;color:#9a3412;font-size:13px">This treatment needs a skin patch test at least 48 hours before. If you haven't had one with us recently, please pop in or call us to arrange it.</p>`
      : "";

  const footer = cancelled
    ? "If you didn't ask for this, please get in touch with us."
    : rebook || review
      ? "Don't want these? Just reply and we'll stop."
      : o.cancellationWindowHours > 0
        ? `Need to change? You can move or cancel free of charge up to ${o.cancellationWindowHours} hours before${o.manageUrl ? " from the link above" : ""}.`
        : `Need to change? ${o.shopPhone ? `Call us on <strong>${esc(o.shopPhone)}</strong>` : "Get in touch"} and quote <strong>${esc(o.reference)}</strong>.`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:20px;overflow:hidden">
<tr><td style="background:#18181b;padding:22px 24px">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>${logo}
<td><div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${ACCENT};font-weight:700">${esc(o.shopName)}</div>
<div style="font-size:22px;font-weight:700;color:#ffffff;margin-top:4px">${esc(heading)}</div></td>
</tr></table></td></tr>
<tr><td style="padding:26px 24px 8px;color:#18181b;font-size:15px;line-height:1.55">
<p style="margin:0 0 12px">Hi ${esc(first)},</p>
<p style="margin:0 0 18px">${intro}</p>
${details}
${patch}
${buttons}
</td></tr>
<tr><td style="padding:12px 24px 26px;color:#71717a;font-size:13px;line-height:1.5">${footer}</td></tr>
</table>
<p style="color:#a1a1aa;font-size:11px;margin:14px 0 0">Sent by ${esc(o.shopName)} about an appointment booked with this email address.</p>
</td></tr></table></body></html>`;

  const text = [
    `Hi ${first},`,
    "",
    `${heading}.`,
    "",
    ...(review
      ? [o.reviewUrl ? `Leave a review: ${o.reviewUrl}` : "", o.bookUrl ? `Book your next visit: ${o.bookUrl}` : ""]
      : rebook
      ? [o.bookUrl ? `Book: ${o.bookUrl}` : ""]
      : [
          o.shopName,
          `${day} at ${time}`,
          `${o.summary}${withWho}`,
          `Price: ${price}`,
          ...(depositLine ? [depositLine] : []),
          `Reference: ${o.reference}`,
          ...(o.address ? [`Where: ${o.address}`] : []),
          ...(o.patchTest && !cancelled ? ["", "This treatment needs a patch test at least 48 hours before."] : []),
          "",
          ...(cancelled
            ? o.bookUrl
              ? [`Book again: ${o.bookUrl}`]
              : []
            : o.manageUrl
              ? [`View or change: ${o.manageUrl}`]
              : []),
        ]),
  ].join("\n");

  return { subject, html, text };
}

/** The reminder text message — short, one segment where possible. */
export function salonReminderSms(o: {
  shopName: string;
  startsAt: Date;
  timezone: string;
  staffName: string | null;
  manageUrl: string | null;
}): string {
  const { time } = formatWhen(o.startsAt, o.timezone);
  const day = o.startsAt.toLocaleDateString("en-GB", { timeZone: o.timezone, weekday: "short", day: "numeric", month: "short" });
  return `${o.shopName}: reminder of your appointment ${day} at ${time}${o.staffName ? ` with ${o.staffName}` : ""}.${
    o.manageUrl ? ` Change/cancel: ${o.manageUrl}` : ""
  }`;
}
