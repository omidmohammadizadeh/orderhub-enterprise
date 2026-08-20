// Plain-text export of the dashboard activity feed.
//
// Lives OUTSIDE the page file on purpose: a Next.js App Router page may only
// export a default component plus a fixed set of route options, so a named
// export there fails `next build` with "not a valid Page export field" —
// which `tsc --noEmit` does not catch, only the real build does.

export type LogEntry = {
  id: string;
  category: string;
  channel: string | null;
  action: string;
  status: "SUCCESS" | "ERROR" | "INFO" | "WARNING";
  message: string;
  details: Record<string, unknown> | null;
  locationId: string | null;
  brandId: string | null;
  brandName: string | null;
  createdAt: string;
};

export interface LogExportScope {
  locationName: string | null;
  locationId: string | null;
  category: string;
  channel: string;
  status: string;
}

/**
 * Render the loaded feed as plain text for pasting into a support ticket.
 *
 * Written for the reader on the other end — Uber, Deliveroo and JET all ask
 * for log evidence, and what they need is a timestamp they can match against
 * their own records plus the HTTP result. So: **UTC ISO timestamps** (never
 * the browser's local time, which is unmatchable to a platform's logs), and
 * the `details` blob verbatim, because that is where the order ids, event ids
 * and HTTP statuses live.
 *
 * The header states the scope explicitly. A pasted log with no scope line
 * invites the reader to assume it covers everything, and "no activity" then
 * reads as "the integration is dead" rather than "wrong location selected".
 */
export function buildLogExport(
  entries: LogEntry[],
  scope: LogExportScope,
): string {
  const header = [
    "OrderHub activity log export",
    `Scope     : ${
      scope.locationId
        ? `${scope.locationName ?? "location"} (${scope.locationId})`
        : "All locations this account can access"
    }`,
    `Filters   : category=${scope.category || "all"} channel=${scope.channel || "all"} status=${scope.status || "any"}`,
    `Exported  : ${new Date().toISOString()}`,
    `Entries   : ${entries.length} (newest first)`,
    "",
  ];
  const lines = entries.map((e) => {
    const when = new Date(e.createdAt).toISOString();
    const head =
      `[${when}] ${e.status.padEnd(7)} ${(e.channel ?? "-").padEnd(10)} ` +
      `${e.action} — ${e.message}`;
    // Details carry the platform order ids and HTTP statuses — the part a
    // support reviewer actually cross-references. Never truncate them.
    const detail =
      e.details && Object.keys(e.details).length
        ? `\n    ${JSON.stringify(e.details)}`
        : "";
    return head + detail;
  });
  return header.concat(lines).join("\n");
}
