"use client";

// The salon's numbers for a date range: what each person took, their tips
// and commission, how full their book was, and who didn't turn up.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrency } from "@/hooks/use-currency";
import { addDays, apiError, longDate, salonClient, todayIn } from "@/lib/api/salon.client";
import { SalonFrame, staffWord, useSalonLocation } from "@/components/salon/salon-shared";

type Range = "today" | "week" | "month" | "custom";

export default function SalonReportsPage() {
  return (
    <SalonFrame title="Reports" subtitle="Takings, tips, commission and how full the book was.">
      <Reports />
    </SalonFrame>
  );
}

function Reports() {
  const { money } = useCurrency();
  const { locationId, settings } = useSalonLocation();
  const tz = settings.data?.timezone ?? "Europe/London";
  const trade = settings.data?.settings.trade;
  const today = todayIn(tz);
  const [range, setRange] = useState<Range>("week");
  const [custom, setCustom] = useState({ from: addDays(today, -6), to: today });
  const { from, to } = useMemo(() => {
    if (range === "today") return { from: today, to: today };
    if (range === "week") return { from: addDays(today, -6), to: today };
    if (range === "month") return { from: addDays(today, -29), to: today };
    return custom;
  }, [range, custom, today]);

  const q = useQuery({
    queryKey: ["salon", "report", locationId, from, to],
    queryFn: () => salonClient.report({ locationId: locationId!, from, to }),
    enabled: !!locationId && from <= to,
  });
  const r = q.data;
  const maxDay = Math.max(1, ...(r?.byDay ?? []).map((d) => d.takings));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Date range" className="flex rounded-lg bg-zinc-100 p-0.5">
          {(
            [
              ["today", "Today"],
              ["week", "7 days"],
              ["month", "30 days"],
              ["custom", "Pick dates"],
            ] as Array<[Range, string]>
          ).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={range === k} onClick={() => setRange(k)} className={`h-9 rounded-md px-3 text-sm font-medium ${range === k ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-600"}`}>
              {l}
            </button>
          ))}
        </div>
        {range === "custom" && (
          <>
            <input type="date" aria-label="From" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="h-10 rounded-lg border border-zinc-200 px-2 text-sm" />
            <input type="date" aria-label="To" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="h-10 rounded-lg border border-zinc-200 px-2 text-sm" />
          </>
        )}
        <p className="text-sm text-zinc-500">
          {from === to ? longDate(from) : `${longDate(from)} – ${longDate(to)}`}
        </p>
      </div>

      {q.isError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{apiError(q.error, "Couldn't load the report")}</p>}
      {q.isLoading && <div className="h-48 animate-pulse rounded-2xl bg-zinc-100" />}

      {r && (
        <>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat k="Service takings" v={money(r.totals.takings)} sub={`${r.totals.completed} visits`} />
            <Stat k="Tips" v={money(r.totals.tips)} />
            <Stat k="Commission due" v={money(r.totals.commission)} />
            <Stat
              k="No-shows"
              v={String(r.totals.noShows)}
              sub={r.totals.depositsKept > 0 ? `${money(r.totals.depositsKept)} in deposits kept` : `${r.totals.cancelled} cancelled`}
            />
            <Stat k="Clients" v={String(r.totals.clients)} sub={`${r.totals.newClients} new`} />
            <Stat k="Booked online" v={`${Math.round(r.totals.onlineShare * 100)}%`} sub={`${r.bySource.ONLINE ?? 0} bookings`} />
            <Stat k="Walk-ins" v={String(r.bySource.WALK_IN ?? 0)} />
            <Stat k="Deposits held" v={money(r.totals.depositsHeld)} sub="for visits still to come" />
          </dl>

          <section className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white">
            <table className="w-full min-w-[720px] text-sm">
              <caption className="border-b border-zinc-100 px-4 py-3 text-left text-sm font-semibold text-zinc-800">By {staffWord(trade).toLowerCase()}</caption>
              <thead className="text-left text-xs text-zinc-500">
                <tr className="border-b border-zinc-100">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-2 py-2 text-right font-medium">Visits</th>
                  <th className="px-2 py-2 text-right font-medium">Takings</th>
                  <th className="px-2 py-2 text-right font-medium">Avg ticket</th>
                  <th className="px-2 py-2 text-right font-medium">Tips</th>
                  <th className="px-2 py-2 text-right font-medium">Commission</th>
                  <th className="px-2 py-2 font-medium">How full</th>
                  <th className="px-4 py-2 text-right font-medium">No-shows</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {r.staff.map((s) => (
                  <tr key={s.staffId}>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-2 font-medium text-zinc-900">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.colour }} aria-hidden />
                        {s.name}
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {s.completed}
                      {s.walkIns ? <span className="text-xs text-zinc-400"> ({s.walkIns} walk-in)</span> : null}
                    </td>
                    <td className="px-2 py-2.5 text-right font-semibold tabular-nums">{money(s.takings)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">{money(s.averageTicket)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">{money(s.tips)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {s.commissionPercent != null ? money(s.commission) : <span className="text-zinc-400">—</span>}
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 overflow-hidden rounded-full bg-zinc-100" role="img" aria-label={`${Math.round(s.utilisation * 100)}% booked`}>
                          <div className="h-full rounded-full bg-orange-500" style={{ width: `${Math.round(s.utilisation * 100)}%` }} />
                        </div>
                        <span className="text-xs tabular-nums text-zinc-600">{Math.round(s.utilisation * 100)}%</span>
                      </div>
                    </td>
                    <td className={`px-4 py-2.5 text-right tabular-nums ${s.noShows ? "font-semibold text-red-600" : ""}`}>{s.noShows}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
            <section className="rounded-2xl border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-zinc-800">Takings by day</h2>
              <ul className="mt-3 space-y-1.5">
                {r.byDay.map((d) => (
                  <li key={d.date} className="flex items-center gap-3 text-sm">
                    <span className="w-24 shrink-0 text-xs text-zinc-500">{longDate(d.date).split(" ").slice(0, 3).join(" ")}</span>
                    <span className="h-3 flex-1 overflow-hidden rounded bg-zinc-100">
                      <span className="block h-full rounded bg-zinc-800" style={{ width: `${(d.takings / maxDay) * 100}%` }} />
                    </span>
                    <span className="w-20 shrink-0 text-right tabular-nums">{money(d.takings)}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="rounded-2xl border border-zinc-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-zinc-800">Top services</h2>
              {r.services.length === 0 ? (
                <p className="mt-3 text-sm text-zinc-500">Nothing checked out yet in this range.</p>
              ) : (
                <ul className="mt-3 divide-y divide-zinc-100 text-sm">
                  {r.services.map((s) => (
                    <li key={s.name} className="flex justify-between gap-3 py-1.5">
                      <span className="truncate">{s.name}</span>
                      <span className="shrink-0 tabular-nums text-zinc-600">
                        {s.count} · {money(s.takings)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          <p className="text-xs text-zinc-500">
            Takings are services at the price they were checked out at. Product sales and deposits show on the Payments and Analytics pages with the rest of your sales.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4">
      <dt className="text-xs text-zinc-500">{k}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums text-zinc-900">{v}</dd>
      {sub && <dd className="text-xs text-zinc-500">{sub}</dd>}
    </div>
  );
}
