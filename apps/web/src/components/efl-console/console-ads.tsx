"use client";

// Console → Sponsored ads: every shop that has set up ads, how they're doing
// this week, and what's still to be taken back. The shop sets its own budget
// and bid in OrderHub; the Console can only pause a shop's ads or allow them again.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { eflAdminClient, type EflAdminAdRow } from "@/lib/api/efl.client";
import { apiErrorMessage, formatGbp } from "./format";

function statusOf(row: EflAdminAdRow): { text: string; cls: string } {
  if (row.pausedByAdmin) return { text: "Paused by us", cls: "bg-red-50 text-red-700" };
  if (row.active) return { text: "Running", cls: "bg-[#D4FF3F] text-[#0B0B0B]" };
  return { text: "Off", cls: "bg-zinc-100 text-zinc-600" };
}

export function ConsoleAds() {
  const qc = useQueryClient();
  const ads = useQuery({ queryKey: ["efl-admin", "ads"], queryFn: eflAdminClient.ads, refetchInterval: 60_000 });

  const pause = useMutation({
    mutationFn: ({ listingId, paused }: { listingId: string; paused: boolean }) =>
      eflAdminClient.pauseAds(listingId, paused),
    onSuccess: (_r, v) => {
      toast.success(v.paused ? "Ads paused" : "Ads allowed again");
      qc.invalidateQueries({ queryKey: ["efl-admin", "ads"] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Couldn't change this shop's ads")),
  });

  const rows = ads.data ?? [];

  return (
    <>
      <header>
        <h1 className="text-[28px] font-extrabold tracking-tight">Sponsored ads</h1>
        <p className="mt-1 max-w-3xl text-[13px] text-zinc-600">
          Shops set a weekly budget and the most they&apos;ll pay per tap. An automatic auction picks 2 sponsored places in
          each customer&apos;s list of shops. What a shop spends is taken back from its next orders, never more than half the
          food.
        </p>
      </header>

      <section aria-label="Shops with ads" className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white">
        {ads.isLoading ? (
          <p className="p-6 text-sm text-zinc-500">Loading ads…</p>
        ) : ads.isError ? (
          <p className="p-8 text-center text-sm text-red-700">{apiErrorMessage(ads.error, "Couldn't load ads.")}</p>
        ) : rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-zinc-500">
            No shop has set up sponsored ads yet. Shops do it in OrderHub → Locations → Platforms → Eat For Less.
          </p>
        ) : (
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="text-[11px] font-semibold text-zinc-400">
                <td colSpan={4} />
                <th scope="colgroup" colSpan={4} className="border-b border-zinc-100 px-4 pt-3 pb-1 text-center">
                  This week
                </th>
                <td colSpan={2} />
              </tr>
              <tr className="text-xs font-bold text-zinc-500">
                <th scope="col" className="px-4 py-3">Shop</th>
                <th scope="col" className="px-4 py-3">Status</th>
                <th scope="col" className="px-4 py-3 text-right">Weekly budget</th>
                <th scope="col" className="px-4 py-3 text-right">Max per tap</th>
                <th scope="col" className="px-4 py-3 text-right">Shown</th>
                <th scope="col" className="px-4 py-3 text-right">Taps</th>
                <th scope="col" className="px-4 py-3 text-right">Orders</th>
                <th scope="col" className="px-4 py-3 text-right">Spent</th>
                <th scope="col" className="px-4 py-3 text-right">Still to take back</th>
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const status = statusOf(r);
                const busy = pause.isPending && pause.variables?.listingId === r.listingId;
                return (
                  <tr key={r.listingId} className="border-t border-zinc-100">
                    <td className="px-4 py-3">
                      <span className="block font-bold">{r.shopName ?? "Unnamed shop"}</span>
                      <span className="block text-xs text-zinc-500">{r.town ?? "—"}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex whitespace-nowrap rounded-lg px-2 py-1 text-xs font-bold ${status.cls}`}>
                        {status.text}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatGbp(r.weeklyBudget)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatGbp(r.maxBid)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{r.thisWeek.shows.toLocaleString("en-GB")}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{r.thisWeek.taps.toLocaleString("en-GB")}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{r.thisWeek.orders.toLocaleString("en-GB")}</td>
                    <td className="px-4 py-3 text-right font-bold tabular-nums">{formatGbp(r.thisWeek.spent)}</td>
                    <td className={"px-4 py-3 text-right tabular-nums " + (r.owed > 0 ? "font-bold" : "text-zinc-500")}>
                      {formatGbp(r.owed)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => pause.mutate({ listingId: r.listingId, paused: !r.pausedByAdmin })}
                        aria-label={`${r.pausedByAdmin ? "Allow ads again for" : "Pause ads for"} ${r.shopName ?? "this shop"}`}
                        className={
                          "inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-[13px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0B0B0B] disabled:opacity-50 " +
                          (r.pausedByAdmin
                            ? "bg-[#D4FF3F] text-[#0B0B0B] hover:brightness-95"
                            : "border border-red-200 bg-white text-red-700 hover:bg-red-50")
                        }
                      >
                        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                        {r.pausedByAdmin ? "Allow again" : "Pause"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
