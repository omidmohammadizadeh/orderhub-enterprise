import type { EmailAudience } from "@orderhub/shared";

// The audience query, as a pure function so it can be tested without a
// database. Segments are computed from the ORDERS table at send time rather
// than copied onto contacts — a copied "last ordered" column is wrong the day
// after nobody refreshes it, and "lapsed" is exactly the segment where being
// wrong means emailing someone who ordered yesterday a "we miss you".

/** Statuses that are not a real, paid order. */
export const NOT_REAL_ORDER = ["PENDING", "CANCELLED", "REJECTED", "FAILED"];

/** The address an order belongs to, most trustworthy first: the signed-in
 *  account, then the CRM record, then whatever was typed at checkout. */
export const ORDER_EMAIL_SQL = `lower(trim(COALESCE(ca.email, c.email, o."customerInfo"->>'email')))`;

export interface AudienceQuery {
  sql: string;
  params: unknown[];
}

/**
 * @param locationIds null = every shop in the tenant; otherwise only contacts
 *   homed at, or who ordered from, these shops — with order stats counted at
 *   these shops only, so a franchisee's "regulars" are THEIR regulars.
 * @param mode "rows" returns id/email/firstName; "count" returns one number.
 */
export function buildAudienceQuery(
  tenantId: string,
  audience: Partial<EmailAudience> | null | undefined,
  locationIds: string[] | null,
  mode: "rows" | "count",
  now: Date = new Date(),
): AudienceQuery {
  const params: unknown[] = [tenantId];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  const orderScope = locationIds ? `AND o."locationId" = ANY(${p(locationIds)}::text[])` : "";
  const locParam = locationIds ? `$${params.length}` : null;

  const where: string[] = [`ec."tenantId" = $1`, `ec.status = 'SUBSCRIBED'`];
  if (locParam) where.push(`(ec."locationId" = ANY(${locParam}::text[]) OR s.email IS NOT NULL)`);

  const seg = audience?.segment ?? "ALL";
  const days = clampInt(audience?.days, 1, 3650, seg === "LAPSED" ? 45 : 30);
  const since = new Date(now.getTime() - days * 86400_000);
  switch (seg) {
    case "RECENT":
      where.push(`s.last_at >= ${p(since)}`);
      break;
    case "LAPSED":
      where.push(`s.last_at < ${p(since)}`);
      break;
    case "NEW":
      where.push(`s.first_at >= ${p(since)}`);
      break;
    case "LOYAL":
      where.push(`s.n >= ${p(clampInt(audience?.minOrders, 1, 10000, 5))}`);
      break;
    case "TOP_SPENDERS":
      where.push(`s.spent >= ${p(Math.max(0, Number(audience?.minSpend ?? 100) || 0))}`);
      break;
    case "NEVER_ORDERED":
      where.push(`s.email IS NULL`);
      break;
    default:
      break;
  }
  if (audience?.brandId) where.push(`${p(audience.brandId)} = ANY(s.brands)`);
  const tags = (audience?.tags ?? []).filter((t) => typeof t === "string" && t.trim());
  if (tags.length) where.push(`ec.tags && ${p(tags)}::text[]`);

  const select =
    mode === "count"
      ? `SELECT COUNT(*)::int AS count`
      : `SELECT ec.id, ec.email, ec."firstName"`;

  const sql = `
WITH o AS (
  SELECT ${ORDER_EMAIL_SQL} AS email, o."createdAt", o.total, o."brandId"
  FROM orders o
  LEFT JOIN customer_accounts ca ON ca.id = o."customerAccountId"
  LEFT JOIN customers c ON c.id = o."customerId"
  WHERE o."tenantId" = $1 AND o."isSandbox" = false
    AND o.status::text NOT IN ('${NOT_REAL_ORDER.join("','")}')
    ${orderScope}
), s AS (
  SELECT email, COUNT(*)::int AS n, MIN("createdAt") AS first_at, MAX("createdAt") AS last_at,
         COALESCE(SUM(total), 0)::float AS spent,
         array_agg(DISTINCT "brandId") FILTER (WHERE "brandId" IS NOT NULL) AS brands
  FROM o WHERE email LIKE '%@%' GROUP BY email
)
${select}
FROM email_contacts ec
LEFT JOIN s ON s.email = ec.email
WHERE ${where.join("\n  AND ")}
${mode === "rows" ? "ORDER BY ec.id" : ""}`;
  return { sql, params };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

/** Lower-cased, trimmed address, or null if it can't be one. */
export function normaliseEmail(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s.length > 254 || !EMAIL_RE.test(s)) return null;
  return s;
}

/** Pennies to charge for `billable` emails at a per-1,000 price — rounded UP,
 *  so 1 email at £3/1,000 is 1p, never free. */
export function emailCostMinor(billable: number, pricePer1000Minor: number): number {
  if (billable <= 0 || pricePer1000Minor <= 0) return 0;
  return Math.ceil((billable * pricePer1000Minor) / 1000);
}

/**
 * Who an automation should email on this run.
 *
 *   WELCOME  — subscribed since the automation was switched on (never the
 *              whole existing list), at least `delayHours` ago, never welcomed
 *              by this automation before.
 *   WIN_BACK — last real order AT THIS SHOP (and brand, when set) more than
 *              `days` ago but within a year (beyond that the email is spam,
 *              not a nudge), and no win-back from this automation within
 *              `cooldownDays`.
 *
 * "Already sent" is checked across every ledger campaign of the automation,
 * so editing the email (which starts a new ledger) can't send it twice.
 */
export function buildAutomationQuery(args: {
  tenantId: string;
  automationId: string;
  type: "WELCOME" | "WIN_BACK";
  locationId: string;
  brandId?: string | null;
  enabledAt: Date;
  delayHours?: number;
  days?: number;
  cooldownDays?: number;
  limit: number;
  now?: Date;
}): AudienceQuery {
  const now = args.now ?? new Date();
  const params: unknown[] = [args.tenantId, args.locationId, args.automationId];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const brand = args.brandId ? `AND o."brandId" = ${p(args.brandId)}` : "";
  const where: string[] = [
    `ec."tenantId" = $1`,
    `ec.status = 'SUBSCRIBED'`,
    `(ec."locationId" = $2 OR s.email IS NOT NULL)`,
  ];
  if (args.type === "WELCOME") {
    const delay = clampInt(args.delayHours, 0, 24 * 14, 1);
    // A welcome is for someone who just joined: switched on today, it greets
    // people from today — and never anyone who joined over a week ago.
    const since = new Date(Math.max(args.enabledAt.getTime(), now.getTime() - 7 * 86400_000));
    const joined = `COALESCE(ec."consentAt", ec."createdAt")`;
    where.push(`${joined} >= ${p(since)}`);
    where.push(`${joined} <= ${p(new Date(now.getTime() - delay * 3600_000))}`);
    where.push(`NOT EXISTS (
      SELECT 1 FROM email_campaign_recipients r JOIN email_campaigns c ON c.id = r."campaignId"
      WHERE c."automationId" = $3 AND r.email = ec.email)`);
  } else {
    const days = clampInt(args.days, 7, 365, 45);
    const cooldown = clampInt(args.cooldownDays, 14, 365, 90);
    where.push(`s.last_at < ${p(new Date(now.getTime() - days * 86400_000))}`);
    where.push(`s.last_at >= ${p(new Date(now.getTime() - 365 * 86400_000))}`);
    where.push(`NOT EXISTS (
      SELECT 1 FROM email_campaign_recipients r JOIN email_campaigns c ON c.id = r."campaignId"
      WHERE c."automationId" = $3 AND r.email = ec.email
        AND r."createdAt" >= ${p(new Date(now.getTime() - cooldown * 86400_000))})`);
  }
  const sql = `
WITH o AS (
  SELECT ${ORDER_EMAIL_SQL} AS email, o."createdAt"
  FROM orders o
  LEFT JOIN customer_accounts ca ON ca.id = o."customerAccountId"
  LEFT JOIN customers c ON c.id = o."customerId"
  WHERE o."tenantId" = $1 AND o."locationId" = $2 AND o."isSandbox" = false
    AND o.status::text NOT IN ('${NOT_REAL_ORDER.join("','")}')
    ${brand}
), s AS (
  SELECT email, MAX("createdAt") AS last_at FROM o WHERE email LIKE '%@%' GROUP BY email
)
SELECT ec.id, ec.email, ec."firstName"
FROM email_contacts ec
LEFT JOIN s ON s.email = ec.email
WHERE ${where.join("\n  AND ")}
ORDER BY ec.id
LIMIT ${clampInt(args.limit, 1, 5000, 1000)}`;
  return { sql, params };
}
