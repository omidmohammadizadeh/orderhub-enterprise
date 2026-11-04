// Finding an order on the live board from what a customer says on the phone:
// their name, the Order ID or ticket number on their receipt, or their phone.

type SearchableOrder = {
  id: string;
  displayId?: string | null;
  orderNumber?: number | null;
  ticketNumber?: number | null;
  customerInfo?: { name?: string | null; phone?: string | null } | null;
  customerName?: string | null;
  customerPhone?: string | null;
};

// The dialling codes of the countries we trade in, so "+44 7788" finds a number
// saved as "07788…" and the other way round.
const COUNTRY_CODES = ["44", "971", "966", "965", "974", "973", "968"];

// Shorter than this, digits match too many numbers to mean anything.
const MIN_PHONE_DIGITS = 3;

const folded = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

function matchesPhone(phone: string, queryDigits: string): boolean {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return false;
  const code = COUNTRY_CODES.find((c) => queryDigits.startsWith(c));
  const candidates = [
    queryDigits,
    queryDigits.replace(/^0+/, ""),
    code ? queryDigits.slice(code.length) : "",
  ];
  return candidates.some(
    (c) => c.length >= MIN_PHONE_DIGITS && digits.includes(c),
  );
}

export function orderMatchesSearch(
  order: SearchableOrder,
  query: string,
): boolean {
  const q = folded(query.trim());
  if (!q) return true;

  const name = order.customerInfo?.name ?? order.customerName ?? "";
  if (folded(name).includes(q)) return true;

  const refs = [
    order.displayId,
    order.orderNumber != null ? String(order.orderNumber) : null,
    order.id.slice(-6),
  ];
  const ticket = order.ticketNumber != null ? String(order.ticketNumber) : null;
  const ref = q.replace(/^#/, "").replace(/\s+/g, "");

  // "ticket 12" can only mean a ticket.
  const asked = q.match(/^(?:ticket|tkt|t)\s*#?\s*(\d+)$/);
  if (asked) return ticket === asked[1];

  // A short number is someone calling out a ticket: "12" means ticket 12 (or an
  // order numbered exactly 12), not every order ID with a 12 somewhere in it.
  if (/^\d{1,3}$/.test(ref)) {
    return ref === ticket || refs.some((r) => r === ref);
  }

  // The same references the row shows, with or without the "#".
  if (ref && refs.some((r) => r && folded(r).includes(ref))) return true;

  // Letters mean it's a name or a reference, never a phone number.
  if (/[a-z]/.test(q)) return false;
  const queryDigits = q.replace(/\D/g, "");
  const phones = [order.customerInfo?.phone, order.customerPhone];
  return phones.some((p) => !!p && matchesPhone(p, queryDigits));
}
