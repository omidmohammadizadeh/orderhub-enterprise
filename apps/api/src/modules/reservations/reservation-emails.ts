// The three emails a guest gets about a table booking: it's confirmed, it
// moved, it was cancelled.
//
// Table layout and inline styles only — that is what every mail client
// renders. Times are written in the RESTAURANT's timezone, never the server's:
// Render runs in UTC, and "19:00" printed as "18:00" in British Summer Time
// sends a party to the door an hour early.

export type ReservationEmailKind = "confirmed" | "updated" | "cancelled";

export interface ReservationEmailInput {
  kind: ReservationEmailKind;
  shopName: string;
  logoUrl: string | null;
  address: string | null;
  shopPhone: string | null;
  timezone: string;
  customerName: string;
  partySize: number;
  startsAt: Date;
  durationMins: number;
  reference: string;
  notes: string | null;
  /** Where "Book again" points — the public booking page. */
  bookUrl: string | null;
}

const ACCENT = "#f97316";

function esc(v: string): string {
  return v.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export function formatWhen(d: Date, timezone: string): { day: string; time: string } {
  const tz = timezone || "Europe/London";
  return {
    day: d.toLocaleDateString("en-GB", {
      timeZone: tz,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }),
    time: d.toLocaleTimeString("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
    }),
  };
}

/** "Add to Google Calendar" — a plain link, so no attachment or endpoint. */
export function googleCalendarUrl(opts: {
  title: string;
  startsAt: Date;
  durationMins: number;
  location: string | null;
  details: string;
}): string {
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const end = new Date(opts.startsAt.getTime() + opts.durationMins * 60_000);
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: opts.title,
    dates: `${stamp(opts.startsAt)}/${stamp(end)}`,
    details: opts.details,
    ...(opts.location ? { location: opts.location } : {}),
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

function row(k: string, v: string): string {
  return `<tr><td style="padding:10px 0;border-top:1px solid #f4f4f5;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:.06em;width:110px;vertical-align:top">${k}</td><td style="padding:10px 0;border-top:1px solid #f4f4f5;color:#18181b;font-size:15px">${v}</td></tr>`;
}

function button(href: string, label: string, primary: boolean): string {
  return `<td style="padding:0 8px 8px 0"><a href="${esc(href)}" style="display:inline-block;padding:12px 18px;border-radius:12px;font-size:14px;font-weight:600;text-decoration:none;${
    primary
      ? `background:${ACCENT};color:#ffffff`
      : "background:#f4f4f5;color:#18181b"
  }">${esc(label)}</a></td>`;
}

export function reservationEmail(o: ReservationEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const { day, time } = formatWhen(o.startsAt, o.timezone);
  const people = `${o.partySize} ${o.partySize === 1 ? "person" : "people"}`;
  const first = o.customerName.trim().split(/\s+/)[0] || o.customerName;

  const heading =
    o.kind === "confirmed"
      ? "Your table is booked"
      : o.kind === "updated"
        ? "Your booking has changed"
        : "Your booking is cancelled";
  const intro =
    o.kind === "confirmed"
      ? `Thanks for booking with <strong>${esc(o.shopName)}</strong> — we're looking forward to seeing you.`
      : o.kind === "updated"
        ? `Your booking at <strong>${esc(o.shopName)}</strong> has been updated. Here are the new details.`
        : `Your booking at <strong>${esc(o.shopName)}</strong> has been cancelled. We hope to see you another time.`;
  const subject =
    o.kind === "confirmed"
      ? `Booking confirmed — ${o.shopName}, ${day} at ${time}`
      : o.kind === "updated"
        ? `Booking updated — ${o.shopName}, ${day} at ${time}`
        : `Booking cancelled — ${o.shopName}`;

  const calUrl = googleCalendarUrl({
    title: `Table at ${o.shopName}`,
    startsAt: o.startsAt,
    durationMins: o.durationMins,
    location: o.address,
    details: `Table for ${people}. Reference ${o.reference}.`,
  });

  const logo = o.logoUrl
    ? `<td style="padding-right:12px"><img src="${esc(o.logoUrl)}" width="44" height="44" alt="" style="display:block;border-radius:10px;background:#fff;object-fit:contain" /></td>`
    : "";
  const cancelled = o.kind === "cancelled";

  const buttons = cancelled
    ? o.bookUrl
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr>${button(o.bookUrl, "Book another table", true)}</tr></table>`
      : ""
    : `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr>${button(calUrl, "Add to calendar", true)}${
        o.shopPhone ? button(`tel:${o.shopPhone.replace(/[^\d+]/g, "")}`, "Call us", false) : ""
      }</tr></table>`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:20px;overflow:hidden">
<tr><td style="background:#18181b;padding:22px 24px">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>${logo}
<td><div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${ACCENT};font-weight:700">${esc(o.shopName)}</div>
<div style="font-size:22px;font-weight:700;color:#ffffff;margin-top:4px">${heading}</div></td>
</tr></table></td></tr>
<tr><td style="padding:26px 24px 8px;color:#18181b;font-size:15px;line-height:1.55">
<p style="margin:0 0 12px">Hi ${esc(first)},</p>
<p style="margin:0 0 18px">${intro}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${cancelled ? "opacity:.6;" : ""}">
${row("Date", `<strong>${esc(day)}</strong>`)}
${row("Time", `<strong>${esc(time)}</strong>`)}
${row("Guests", esc(people))}
${row("Reference", `<span style="font-family:Menlo,Consolas,monospace;font-weight:700;letter-spacing:.06em">${esc(o.reference)}</span>`)}
${o.notes && !cancelled ? row("Your note", esc(o.notes)) : ""}
${o.address ? row("Where", esc(o.address)) : ""}
</table>
${buttons}
</td></tr>
<tr><td style="padding:12px 24px 26px;color:#71717a;font-size:13px;line-height:1.5">${
    cancelled
      ? "If you didn't ask for this, please get in touch with us."
      : `Need to change or cancel? ${
          o.shopPhone ? `Call us on <strong>${esc(o.shopPhone)}</strong>` : "Get in touch with us"
        } and quote <strong>${esc(o.reference)}</strong>. Your table is held for ${o.durationMins} minutes.`
  }</td></tr>
</table>
<p style="color:#a1a1aa;font-size:11px;margin:14px 0 0">Sent by ${esc(o.shopName)} because a table was booked with this email address.</p>
</td></tr></table></body></html>`;

  const text = [
    `Hi ${first},`,
    "",
    heading + ".",
    "",
    `${o.shopName}`,
    `${day} at ${time}`,
    `${people}`,
    `Reference: ${o.reference}`,
    ...(o.address ? [`Where: ${o.address}`] : []),
    "",
    cancelled
      ? o.bookUrl
        ? `Book again: ${o.bookUrl}`
        : ""
      : `Need to change or cancel? ${o.shopPhone ? `Call ${o.shopPhone}` : "Get in touch"} and quote ${o.reference}.`,
  ].join("\n");

  return { subject, html, text };
}
