// Client-side contact-list parsing for the import wizard. Turns an uploaded
// file (CSV / Excel .xlsx/.xls / Google Sheets export) or pasted text into a
// normalized [{ phone, firstName, lastName, email }] the API can ingest.
//
// SheetJS (xlsx) is dynamically imported so it isn't in the initial bundle —
// it only loads when the operator actually imports a file.

import type { ImportRow } from "@/lib/api/marketing-sms.client";

export interface ParsedContacts {
  rows: ImportRow[];
  detectedColumns: { phone?: string; firstName?: string; lastName?: string; name?: string; email?: string };
  rawCount: number;
}

// Heuristics to find the right columns from a header row.
const PHONE_KEYS = ["phone", "mobile", "tel", "number", "msisdn", "cell", "contact"];
const FIRST_KEYS = ["first", "firstname", "first name", "fname", "given"];
const LAST_KEYS = ["last", "lastname", "last name", "lname", "surname", "family"];
const NAME_KEYS = ["name", "customer", "full name", "fullname"];
const EMAIL_KEYS = ["email", "e-mail", "mail"];

function matchColumn(headers: string[], keys: string[]): string | undefined {
  const lower = headers.map((h) => h.toLowerCase().trim());
  // Exact-ish match first, then contains.
  for (const k of keys) {
    const i = lower.findIndex((h) => h === k);
    if (i >= 0) return headers[i];
  }
  for (const k of keys) {
    const i = lower.findIndex((h) => h.includes(k));
    if (i >= 0) return headers[i];
  }
  return undefined;
}

function rowsFromRecords(records: Record<string, any>[]): ParsedContacts {
  const headers = records.length ? Object.keys(records[0] ?? {}) : [];
  const cols = {
    phone: matchColumn(headers, PHONE_KEYS),
    firstName: matchColumn(headers, FIRST_KEYS),
    lastName: matchColumn(headers, LAST_KEYS),
    name: matchColumn(headers, NAME_KEYS),
    email: matchColumn(headers, EMAIL_KEYS),
  };
  // Fallback: if no phone column detected, use the first column that looks like
  // it holds phone-ish values.
  let phoneCol = cols.phone;
  if (!phoneCol && headers.length) {
    phoneCol = headers.find((h) =>
      records.slice(0, 20).some((r) => /[\d]{7,}/.test(String(r[h] ?? "").replace(/\D/g, ""))),
    );
    cols.phone = phoneCol;
  }

  const rows: ImportRow[] = [];
  for (const rec of records) {
    const phone = phoneCol ? String(rec[phoneCol] ?? "").trim() : "";
    if (!phone) continue;
    rows.push({
      phone,
      firstName: cols.firstName ? String(rec[cols.firstName] ?? "").trim() || undefined : undefined,
      lastName: cols.lastName ? String(rec[cols.lastName] ?? "").trim() || undefined : undefined,
      name: cols.name && !cols.firstName ? String(rec[cols.name] ?? "").trim() || undefined : undefined,
      email: cols.email ? String(rec[cols.email] ?? "").trim() || undefined : undefined,
    });
  }
  return { rows, detectedColumns: cols, rawCount: records.length };
}

/** Parse an uploaded file (CSV, XLSX, XLS — includes Google Sheets exports). */
export async function parseContactFile(file: File): Promise<ParsedContacts> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const firstSheetName = wb.SheetNames[0];
  const sheet = firstSheetName ? wb.Sheets[firstSheetName] : undefined;
  if (!sheet) return { rows: [], detectedColumns: {}, rawCount: 0 };
  const records = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: "" });
  return rowsFromRecords(records);
}

/**
 * Parse pasted text. Supports "Name, Phone" style CSV lines OR just a column of
 * phone numbers (one per line). Detects a header row if present.
 */
export function parsePastedText(text: string): ParsedContacts {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const firstLine = lines[0];
  if (!firstLine) return { rows: [], detectedColumns: {}, rawCount: 0 };

  const delimiter = firstLine.includes("\t") ? "\t" : ",";
  const split = (l: string) => l.split(delimiter).map((c) => c.trim());

  // Header detection: first row has no long digit run in any cell.
  const firstCells = split(firstLine);
  const looksLikeHeader = !firstCells.some((c) => /\d{7,}/.test(c.replace(/\D/g, "")));

  if (looksLikeHeader && firstCells.length > 1) {
    const headers = firstCells;
    const records = lines.slice(1).map((l) => {
      const cells = split(l);
      const rec: Record<string, any> = {};
      headers.forEach((h, i) => (rec[h] = cells[i] ?? ""));
      return rec;
    });
    return rowsFromRecords(records);
  }

  // No header — treat each line as "phone" or "name,phone".
  const rows: ImportRow[] = [];
  for (const line of lines) {
    const cells = split(line);
    if (cells.length === 1) {
      if (cells[0]) rows.push({ phone: cells[0] });
    } else {
      // Whichever cell has the longest digit run is the phone; the rest is name.
      const phoneIdx = cells.reduce(
        (best, c, i) =>
          c.replace(/\D/g, "").length > (cells[best] ?? "").replace(/\D/g, "").length ? i : best,
        0,
      );
      const phone = cells[phoneIdx];
      if (!phone) continue;
      const name = cells.filter((_, i) => i !== phoneIdx).join(" ").trim();
      rows.push({ phone, name: name || undefined });
    }
  }
  return { rows, detectedColumns: { phone: "auto" }, rawCount: lines.length };
}
