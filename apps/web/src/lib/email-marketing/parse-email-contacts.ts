// Turns an uploaded list (CSV / Excel / Google Sheets export) or pasted text
// into [{ email, firstName, lastName, name }] for the email import. The server
// validates and de-duplicates again; this only finds the right columns.

export interface EmailRow {
  email: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

const EMAIL_RE = /[^\s@<>(),;:"']+@[^\s@<>(),;:"']+\.[a-z]{2,}/i;
const FIRST_KEYS = ["first name", "firstname", "first", "fname", "given"];
const LAST_KEYS = ["last name", "lastname", "last", "surname", "lname", "family"];
const NAME_KEYS = ["full name", "fullname", "name", "customer"];
const EMAIL_KEYS = ["email address", "email", "e-mail", "mail"];

function find(headers: string[], keys: string[]): string | undefined {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const k of keys) {
    const i = lower.indexOf(k);
    if (i >= 0) return headers[i];
  }
  for (const k of keys) {
    const i = lower.findIndex((h) => h.includes(k));
    if (i >= 0) return headers[i];
  }
  return undefined;
}

function fromRecords(records: Record<string, unknown>[]): EmailRow[] {
  const headers = records.length ? Object.keys(records[0] ?? {}) : [];
  const emailCol =
    find(headers, EMAIL_KEYS) ??
    headers.find((h) => records.slice(0, 20).some((r) => EMAIL_RE.test(String(r[h] ?? ""))));
  if (!emailCol) return [];
  const first = find(headers, FIRST_KEYS);
  const last = find(headers, LAST_KEYS);
  const name = first ? undefined : find(headers.filter((h) => h !== emailCol), NAME_KEYS);
  const cell = (r: Record<string, unknown>, c?: string) => (c ? String(r[c] ?? "").trim() || undefined : undefined);
  const out: EmailRow[] = [];
  for (const r of records) {
    const m = String(r[emailCol] ?? "").match(EMAIL_RE);
    if (!m) continue;
    out.push({ email: m[0], firstName: cell(r, first), lastName: cell(r, last), name: cell(r, name) });
  }
  return out;
}

export async function parseEmailFile(file: File): Promise<EmailRow[]> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheetName = wb.SheetNames[0];
  const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!sheet) return [];
  return fromRecords(XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" }));
}

/** One contact per line: "sam@example.com" or "Sam Jones, sam@example.com". */
export function parseEmailText(text: string): EmailRow[] {
  const out: EmailRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(EMAIL_RE);
    if (!m) continue;
    const rest = line.replace(m[0], "").replace(/[<>,;\t"]+/g, " ").trim();
    out.push({ email: m[0], name: rest || undefined });
  }
  return out;
}
