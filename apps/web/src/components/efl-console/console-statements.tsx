"use client";

// Console → Statements: one week of every shop's money — what customers paid,
// what we kept as commission, ad spend taken back, and what each shop is owed.
// Weeks are named by their Monday ("2026-10-26"); no week = last week.

import { useState } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, Loader2, Mail } from "lucide-react";
import toast from "react-hot-toast";
import { eflAdminClient } from "@/lib/api/efl.client";
import { apiErrorMessage, formatGbp } from "./format";

/** The Monday `days` away from `monday`, worked out in UTC so no clock change can shift it. */
function shiftWeek(monday: string, days: number): string {
  const d = new Date(`${monday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** This week's Monday — the newest week worth asking for (it's still being traded). */
function thisMonday(): string {
  const d = new Date();
  const today = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const sinceMonday = (today.getUTCDay() + 6) % 7;
  today.setUTCDate(today.getUTCDate() - sinceMonday);
  return today.toISOString().slice(0, 10);
}

export function ConsoleStatements() {
  // undefined = let the API pick (last week); after the first answer we steer by its Monday.
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [downloading, setDownloading] = useState<string | null>(null);

  const statements = useQuery({
    queryKey: ["efl-admin", "statements", week ?? "default"],
    queryFn: () => eflAdminClient.statements(week),
    placeholderData: keepPreviousData,
  });
  const data = statements.data;
  const shownWeek = data?.week;
  const canGoForward = !!shownWeek && shiftWeek(shownWeek, 7) <= thisMonday();

  const send = useMutation({
    mutationFn: (w: string) => eflAdminClient.sendStatements(w),
    onSuccess: (r) =>
      toast.success(
        r.sent === 0
          ? "Every shop already has this week's statement"
          : `Sent ${r.sent} ${r.sent === 1 ? "statement" : "statements"}`,
      ),
    onError: (err) => toast.error(apiErrorMessage(err, "Couldn't send the statements")),
  });

  const download = async (locationId: string) => {
    if (!shownWeek) return;
    setDownloading(locationId);
    try {
      await eflAdminClient.downloadStatement(locationId, shownWeek);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't download the statement"));
    } finally {
      setDownloading(null);
    }
  };

  const onSend = () => {
    if (!data) return;
    const ok = window.confirm(
      `Email the statement for ${data.weekLabel} to every shop that traded? Shops that already have it won't get it twice.`,
    );
    if (ok) send.mutate(data.week);
  };

  const t = data?.totals;

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-extrabold tracking-tight">Statements</h1>
          <p className="mt-1 text-[13px] text-zinc-600">
            Each shop gets its statement by email automatically every Monday at 7am, for the week before.
          </p>
        </div>
        <button
          type="button"
          onClick={onSend}
          disabled={!data || data.shops.length === 0 || send.isPending}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#0B0B0B] px-4 text-sm font-bold text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D4FF3F] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {send.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Mail className="h-4 w-4" aria-hidden="true" />
          )}
          Email this week&apos;s statements
        </button>
      </header>

      <nav aria-label="Choose a week" className="flex w-fit items-center gap-1 rounded-xl bg-[#EAEAE6] p-1">
        <button
          type="button"
          aria-label="Previous week"
          disabled={!shownWeek}
          onClick={() => shownWeek && setWeek(shiftWeek(shownWeek, -7))}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-700 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0B0B0B] disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <span aria-live="polite" className="flex min-w-[11rem] items-center justify-center gap-2 px-2 text-[13px] font-bold tabular-nums">
          {data?.weekLabel ?? "Loading…"}
          {statements.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" aria-hidden="true" />}
        </span>
        <button
          type="button"
          aria-label="Next week"
          disabled={!canGoForward}
          onClick={() => shownWeek && setWeek(shiftWeek(shownWeek, 7))}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-700 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0B0B0B] disabled:opacity-40"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </nav>

      <section aria-label="Week totals" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Orders" value={t ? `${t.orders}` : "–"} />
        <Tile label="Customers paid" value={t ? formatGbp(t.customerPaid) : "–"} />
        <Tile dark label="Commission" value={t ? formatGbp(t.commission) : "–"} sub="Our income" />
        <Tile label="Ad spend" value={t ? formatGbp(t.adSpent) : "–"} />
        <Tile label="Ads taken back" value={t ? formatGbp(t.adRecovered) : "–"} />
        <Tile label="Paid to shops" value={t ? formatGbp(t.toShops) : "–"} />
      </section>

      <section aria-label="Shops" className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white">
        {statements.isLoading ? (
          <p className="p-6 text-sm text-zinc-500">Loading statements…</p>
        ) : statements.isError ? (
          <p className="p-8 text-center text-sm text-red-700">
            {apiErrorMessage(statements.error, "Couldn't load this week's statements.")}
          </p>
        ) : !data || data.shops.length === 0 ? (
          <p className="p-8 text-center text-sm text-zinc-500">No shop traded on Eat For Less this week.</p>
        ) : (
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="text-xs font-bold text-zinc-500">
                <th className="px-4 py-3">Shop</th>
                <th className="px-4 py-3 text-right">Orders</th>
                <th className="px-4 py-3 text-right">Customers paid</th>
                <th className="px-4 py-3 text-right">Commission</th>
                <th className="px-4 py-3 text-right">Ads taken back</th>
                <th className="px-4 py-3 text-right">Shop&apos;s share</th>
                <th className="px-4 py-3">
                  <span className="sr-only">Statement</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.shops.map((s) => (
                <tr key={s.listingId} className="border-t border-zinc-100">
                  <td className="px-4 py-3">
                    <span className="block font-bold">{s.shopName}</span>
                    {s.refundedOrders > 0 && (
                      <span className="block text-xs text-zinc-500">
                        {s.refundedOrders} refunded {s.refundedOrders === 1 ? "order" : "orders"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{s.orders}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatGbp(s.customerPaid)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatGbp(s.commission)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatGbp(s.ads.recovered)}</td>
                  <td className="px-4 py-3 text-right font-bold tabular-nums">{formatGbp(s.toShop)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => download(s.locationId)}
                      disabled={downloading === s.locationId}
                      aria-label={`Download PDF statement for ${s.shopName}`}
                      className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-xl border border-zinc-300 bg-white px-3 text-[13px] font-semibold hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0B0B0B] disabled:opacity-50"
                    >
                      {downloading === s.locationId ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Download className="h-4 w-4" aria-hidden="true" />
                      )}
                      PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function Tile({ label, value, sub, dark }: { label: string; value: string; sub?: string; dark?: boolean }) {
  return (
    <div
      className={
        "flex min-w-0 flex-col gap-1.5 rounded-2xl p-4 " + (dark ? "bg-[#0B0B0B] text-white" : "border border-zinc-200 bg-white")
      }
    >
      <span className={"text-[13px] font-semibold " + (dark ? "text-zinc-300" : "text-zinc-600")}>{label}</span>
      <span className="truncate text-2xl font-extrabold tabular-nums tracking-tight">{value}</span>
      {sub && <span className={"text-xs " + (dark ? "font-semibold text-[#D4FF3F]" : "text-zinc-500")}>{sub}</span>}
    </div>
  );
}
