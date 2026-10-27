"use client";

// Locations → Brands → Eat For Less → Weekly statements.
//
// The last 12 weeks of a shop's Eat For Less money, one row a week, each
// downloadable as a PDF or emailed again. A statement is a record only:
// card money lands in the shop's own Stripe account as each order is paid.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Mail } from "lucide-react";
import toast from "react-hot-toast";
import { eflClient, type EflShopListing, type EflStatementSummary } from "@/lib/api/efl.client";
import { formatCurrency } from "@/lib/utils";

export function eflStatementsQueryKey(locationId: string) {
  return ["efl-statements", locationId] as const;
}

/** Same key as eflListingQueryKey — inlined to keep the panel ↔ section import one-way. */
const listingKey = (locationId: string) => ["efl-listing", locationId] as const;

const gbp = (n: number) => formatCurrency(n, "GBP");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A failed blob download carries its JSON error as a Blob — read it out. */
async function errorMessage(err: any, fallback: string): Promise<string> {
  const data = err?.response?.data;
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text());
      if (typeof parsed?.message === "string") return parsed.message;
    } catch {
      /* not JSON */
    }
    return fallback;
  }
  return data?.message ?? fallback;
}

export function EflStatementsSection({ locationId, listing }: { locationId: string; listing: EflShopListing }) {
  const qc = useQueryClient();
  const headingId = `efl-statements-heading-${locationId}`;
  const emailId = `efl-statements-email-${locationId}`;
  const emailHintId = `efl-statements-email-hint-${locationId}`;

  const query = useQuery({
    queryKey: eflStatementsQueryKey(locationId),
    queryFn: () => eflClient.statements(locationId),
  });

  // ── Where statements go ──────────────────────────────────────────────
  const savedEmail = listing.statementEmail ?? "";
  const [email, setEmail] = useState(savedEmail);
  useEffect(() => setEmail(savedEmail), [savedEmail]);
  const trimmed = email.trim();
  const emailInvalid = trimmed !== "" && !EMAIL_RE.test(trimmed);
  const emailDirty = trimmed !== savedEmail;

  const saveEmail = useMutation({
    mutationFn: (statementEmail: string | null) => eflClient.updateListing(locationId, { statementEmail }),
    onSuccess: (next) => {
      qc.setQueryData(listingKey(locationId), next);
      void qc.invalidateQueries({ queryKey: listingKey(locationId) });
      void qc.invalidateQueries({ queryKey: eflStatementsQueryKey(locationId) });
      toast.success(next.statementEmail ? `Statements will go to ${next.statementEmail}` : "Statements will go to the account owner");
    },
    onError: (err: any) => toast.error(err?.response?.data?.message ?? "Couldn't save the email"),
  });

  // ── Per-week actions ─────────────────────────────────────────────────
  const download = useMutation({
    mutationFn: (week: string) => eflClient.downloadStatement(locationId, week),
    onError: async (err: any) => toast.error(await errorMessage(err, "Couldn't download the statement")),
  });
  const sendEmail = useMutation({
    mutationFn: (week: string) => eflClient.emailStatement(locationId, week),
    onSuccess: ({ sentTo }) => toast.success(`Sent to ${sentTo}`),
    onError: (err: any) => toast.error(err?.response?.data?.message ?? "Couldn't email the statement"),
  });

  const recipient = query.data?.recipient || listing.statementEmail || "the account owner";

  return (
    <section aria-labelledby={headingId} className="border-t border-zinc-100 px-4 py-4">
      <h3 id={headingId} className="text-sm font-semibold text-zinc-900">
        Weekly statements
      </h3>
      <p className="mt-1 text-[11px] text-zinc-500">
        Every Monday morning we email last week&apos;s statement to{" "}
        <span className="break-all font-semibold text-zinc-700">{recipient}</span>.
      </p>

      <form
        className="mt-3 flex flex-col gap-1.5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!emailDirty || emailInvalid || saveEmail.isPending) return;
          saveEmail.mutate(trimmed === "" ? null : trimmed);
        }}
      >
        <label htmlFor={emailId} className="text-xs font-semibold text-zinc-700">
          Send statements to
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={emailId}
            type="email"
            autoComplete="email"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Leave empty for the account owner"
            aria-invalid={emailInvalid}
            aria-describedby={emailHintId}
            className={
              "h-10 w-full min-w-0 rounded-lg border px-3 text-sm focus:outline-none focus:ring-2 sm:max-w-sm " +
              (emailInvalid
                ? "border-red-400 focus:border-red-600 focus:ring-red-600/10"
                : "border-zinc-300 focus:border-zinc-900 focus:ring-zinc-900/10")
            }
          />
          <button
            type="submit"
            disabled={!emailDirty || emailInvalid || saveEmail.isPending}
            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 text-xs font-semibold text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/30 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saveEmail.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Save email
          </button>
        </div>
        <p id={emailHintId} className={"text-[11px] " + (emailInvalid ? "text-red-700" : "text-zinc-500")}>
          {emailInvalid ? "That doesn't look like an email address." : "Empty sends them to the account owner."}
        </p>
      </form>

      <div className="mt-4">
        {query.isLoading ? (
          <div role="status" className="flex min-h-[160px] items-center gap-2 text-xs text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading statements…
          </div>
        ) : query.isError || !query.data ? (
          <div role="alert" className="flex min-h-[160px] flex-col items-start justify-center gap-2 text-xs text-red-700">
            <span>{(query.error as any)?.response?.data?.message ?? "Couldn't load your statements."}</span>
            <button
              type="button"
              onClick={() => query.refetch()}
              className="h-9 rounded-lg border border-zinc-300 px-3 font-semibold text-zinc-800 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/30"
            >
              Try again
            </button>
          </div>
        ) : query.data.weeks.length === 0 ? (
          <p className="rounded-lg bg-zinc-50 px-3 py-6 text-center text-xs text-zinc-500">
            Your first statement arrives the Monday after your first Eat For Less week.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200">
            {query.data.weeks.slice(0, 12).map((s) => (
              <StatementRow
                key={s.week}
                s={s}
                downloading={download.isPending && download.variables === s.week}
                emailing={sendEmail.isPending && sendEmail.variables === s.week}
                onDownload={() => download.mutate(s.week)}
                onEmail={() => sendEmail.mutate(s.week)}
              />
            ))}
          </ul>
        )}
      </div>

      <p className="mt-3 text-[11px] text-zinc-500">
        Money is paid into your own Stripe account as each order is paid — a statement is a record, there&apos;s
        nothing to pay.
      </p>
    </section>
  );
}

function StatementRow({
  s,
  downloading,
  emailing,
  onDownload,
  onEmail,
}: {
  s: EflStatementSummary;
  downloading: boolean;
  emailing: boolean;
  onDownload: () => void;
  onEmail: () => void;
}) {
  const empty = s.orders === 0 && s.ads.taps === 0;

  return (
    <li
      className={
        "flex flex-col gap-3 px-3 py-3 lg:flex-row lg:items-center lg:justify-between " + (empty ? "bg-zinc-50/60" : "")
      }
    >
      <div className="min-w-0 lg:w-40 lg:shrink-0">
        <p className={"text-xs font-semibold " + (empty ? "text-zinc-400" : "text-zinc-900")}>{s.weekLabel}</p>
        {empty && <p className="text-[11px] text-zinc-400">No orders</p>}
      </div>

      {!empty && (
        <dl className="grid flex-1 grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-5">
          <Cell label="Orders" value={s.orders.toLocaleString("en-GB")} />
          <Cell label="Customers paid" value={gbp(s.customerPaid)} />
          <Cell label="Commission" value={gbp(s.commission)} />
          <Cell label="Ads taken back" value={gbp(s.ads.recovered)} />
          <Cell label="Yours" value={gbp(s.toShop)} strong />
        </dl>
      )}

      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={onDownload}
          disabled={downloading}
          aria-label={`Download PDF for ${s.weekLabel}`}
          className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/30 disabled:cursor-wait disabled:opacity-60 lg:flex-none"
        >
          {downloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Download PDF
        </button>
        {!empty && (
          <button
            type="button"
            onClick={onEmail}
            disabled={emailing}
            aria-label={`Email the statement for ${s.weekLabel}`}
            className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/30 disabled:cursor-wait disabled:opacity-60 lg:flex-none"
          >
            {emailing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Mail className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Email it
          </button>
        )}
      </div>
    </li>
  );
}

function Cell({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium text-zinc-500">{label}</dt>
      <dd className={"text-xs tabular-nums " + (strong ? "font-bold text-zinc-900" : "text-zinc-700")}>{value}</dd>
    </div>
  );
}
