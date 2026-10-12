// Price-list import: the CSV a shop exports from the system it's leaving
// (Fresha, Booksy, Treatwell, Square, a spreadsheet of its own).
//
// Every system names its columns differently, so columns are recognised by
// what they mean, not by one export's spelling. Pure, so it is tested
// against real-looking exports without a database.

export interface ImportedService {
  name: string;
  category: string;
  price: number;
  priceFrom: boolean;
  durationMins: number;
  description: string | null;
}

export interface ImportResult {
  services: ImportedService[];
  skipped: Array<{ row: number; reason: string }>;
  columns: Record<string, string | null>;
}

/** RFC-4180-ish: quoted fields, doubled quotes, commas/semicolons/tabs. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = [",", ";", "\t"].sort(
    (a, b) => firstLine.split(b).length - firstLine.split(a).length,
  )[0]!;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

const NAME = ["service name", "service", "name", "treatment", "title", "item", "product name"];
const CATEGORY = ["category", "service category", "group", "menu section", "section", "type"];
const DURATION = ["duration", "duration (mins)", "duration (minutes)", "mins", "minutes", "length", "time", "service duration"];
const PRICE = ["price", "retail price", "price (£)", "price (gbp)", "full price", "amount", "cost", "price (aed)"];
const DESC = ["description", "details", "notes", "about"];

function pick(headers: string[], wanted: string[]): number {
  const h = headers.map((x) => x.trim().toLowerCase());
  for (const w of wanted) {
    const i = h.indexOf(w);
    if (i >= 0) return i;
  }
  for (const w of wanted) {
    const i = h.findIndex((x) => x.includes(w));
    if (i >= 0) return i;
  }
  return -1;
}

/** "45", "45 min", "1h 15m", "1:15", "1 hr 30 mins", "90m" → minutes. */
export function parseDuration(raw: string): number | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  const colon = s.match(/^(\d{1,2}):(\d{2})$/);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
  const h = s.match(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\b/);
  const m = s.match(/(\d+)\s*(m|min|mins|minute|minutes)\b/);
  if (h || m) return Math.round((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0));
  const n = Number(s.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** "£22.00", "from £45", "22", "AED 85", "22,50" → { price, from }. */
export function parsePrice(raw: string): { price: number; from: boolean } | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  const from = /\bfrom\b|\+$/.test(s);
  // A range ("£40 - £60") is a from-price at its lower end.
  const first = s.match(/\d+(?:[.,]\d{1,2})?/);
  if (!first) return null;
  const n = Number(first[0].replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return null;
  return { price: Math.round(n * 100) / 100, from: from || /\d\s*[-–]\s*\D*\d/.test(s) };
}

export function readPriceList(text: string): ImportResult {
  const rows = parseCsv(text);
  const skipped: ImportResult["skipped"] = [];
  if (rows.length < 2) {
    return { services: [], skipped: [{ row: 1, reason: "No rows found — paste the whole export, header line included" }], columns: {} };
  }
  const headers = rows[0]!;
  const col = {
    name: pick(headers, NAME),
    category: pick(headers, CATEGORY),
    duration: pick(headers, DURATION),
    price: pick(headers, PRICE),
    description: pick(headers, DESC),
    priceType: pick(headers, ["price type", "pricing type"]),
  };
  const columns = Object.fromEntries(
    Object.entries(col).map(([k, i]) => [k, i >= 0 ? (headers[i] ?? "").trim() : null]),
  );
  if (col.name < 0) {
    return { services: [], skipped: [{ row: 1, reason: "Couldn't find a service name column" }], columns };
  }
  const services: ImportedService[] = [];
  const seen = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    const name = (cells[col.name] ?? "").trim();
    if (!name) {
      skipped.push({ row: r + 1, reason: "No name" });
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      skipped.push({ row: r + 1, reason: `"${name}" appears twice — kept the first` });
      continue;
    }
    const price = col.price >= 0 ? parsePrice(cells[col.price] ?? "") : null;
    if (!price) {
      skipped.push({ row: r + 1, reason: `"${name}" has no price` });
      continue;
    }
    const duration = col.duration >= 0 ? parseDuration(cells[col.duration] ?? "") : null;
    seen.add(key);
    services.push({
      name: name.slice(0, 120),
      category: ((col.category >= 0 ? cells[col.category] : "") ?? "").trim().slice(0, 60) || "Services",
      price: price.price,
      priceFrom: price.from || /from/i.test(col.priceType >= 0 ? (cells[col.priceType] ?? "") : ""),
      durationMins: Math.min(12 * 60, Math.max(5, duration ?? 30)),
      description: col.description >= 0 ? ((cells[col.description] ?? "").trim().slice(0, 1000) || null) : null,
    });
  }
  return { services, skipped, columns };
}

// ── Clients ────────────────────────────────────────────────────────────────

export interface ImportedClient {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  marketingConsent: boolean;
}

const FIRST = ["first name", "firstname", "given name", "forename"];
const LAST = ["last name", "lastname", "surname", "family name"];
const FULL = ["client name", "full name", "client", "customer name", "customer", "name"];
const PHONE = ["mobile number", "mobile", "phone number", "phone", "telephone", "mobile phone", "cell"];
const EMAIL = ["email address", "email", "e-mail"];
const CONSENT = ["accepts marketing", "marketing consent", "marketing", "email marketing", "sms marketing", "opted in"];

export function readClientList(text: string): {
  clients: ImportedClient[];
  skipped: Array<{ row: number; reason: string }>;
  columns: Record<string, string | null>;
} {
  const rows = parseCsv(text);
  if (rows.length < 2) return { clients: [], skipped: [{ row: 1, reason: "No rows found" }], columns: {} };
  const headers = rows[0]!;
  const col = {
    first: pick(headers, FIRST),
    last: pick(headers, LAST),
    full: pick(headers, FULL),
    phone: pick(headers, PHONE),
    email: pick(headers, EMAIL),
    consent: pick(headers, CONSENT),
  };
  // "Name" only counts as the full name when there are no separate columns.
  if (col.first >= 0 && col.full >= 0 && (headers[col.full] ?? "").trim().toLowerCase() === "name") col.full = -1;
  const columns = Object.fromEntries(Object.entries(col).map(([k, i]) => [k, i >= 0 ? (headers[i] ?? "").trim() : null]));
  const clients: ImportedClient[] = [];
  const skipped: Array<{ row: number; reason: string }> = [];
  const seen = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r]!;
    let first = col.first >= 0 ? (c[col.first] ?? "").trim() : "";
    let last = col.last >= 0 ? (c[col.last] ?? "").trim() : "";
    if (!first && col.full >= 0) {
      const parts = (c[col.full] ?? "").trim().split(/\s+/);
      first = parts.shift() ?? "";
      last = last || parts.join(" ");
    }
    const phone = col.phone >= 0 ? (c[col.phone] ?? "").trim().replace(/[^\d+]/g, "") : "";
    const email = col.email >= 0 ? (c[col.email] ?? "").trim().toLowerCase() : "";
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
    if (!phone && !validEmail) {
      skipped.push({ row: r + 1, reason: `${first || "A client"} has no phone or email` });
      continue;
    }
    const key = phone || validEmail;
    if (seen.has(key)) {
      skipped.push({ row: r + 1, reason: "Duplicate" });
      continue;
    }
    seen.add(key);
    const consentRaw = col.consent >= 0 ? (c[col.consent] ?? "").trim().toLowerCase() : "";
    clients.push({
      firstName: first.slice(0, 80) || null,
      lastName: last.slice(0, 80) || null,
      phone: phone.length >= 7 ? phone.slice(0, 20) : null,
      email: validEmail || null,
      marketingConsent: ["yes", "true", "1", "y", "opted in", "subscribed"].includes(consentRaw),
    });
  }
  return { clients, skipped, columns };
}
