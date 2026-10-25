"use client";

// Console → Overview: today's trade and anything that needs a decision.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { eflAdminClient } from "@/lib/api/efl.client";
import { formatGbp } from "./format";

export function ConsoleOverview() {
  const summary = useQuery({
    queryKey: ["efl-admin", "summary"],
    queryFn: eflAdminClient.summary,
    refetchInterval: 30_000,
  });
  const listings = useQuery({ queryKey: ["efl-admin", "listings"], queryFn: eflAdminClient.listings });
  const applications = useQuery({ queryKey: ["efl-admin", "applications"], queryFn: eflAdminClient.applications });

  const s = summary.data;
  const waiting = (listings.data ?? []).filter((l) => l.listed && l.status === "PENDING");
  const hidden = (listings.data ?? []).filter((l) => l.hiddenReason || l.status === "SUSPENDED");
  const offMap = (listings.data ?? []).filter((l) => l.listed && !l.placedOnMap);
  const newApplications = (applications.data ?? []).filter((a) => a.status === "NEW");

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-extrabold tracking-tight">Overview</h1>
          <p className="mt-1 flex items-center gap-2 text-[13px] text-zinc-600">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-600" />
            </span>
            Live · updates every 30 seconds
          </p>
        </div>
      </header>

      <section aria-label="Today" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile dark label="Shops live in the app" value={s ? `${s.listings.live}` : "–"} sub={s ? `of ${s.listings.total} listed` : ""} />
        <Tile label="Orders today" value={s ? `${s.today.orders}` : "–"} sub="Paid orders" />
        <Tile label="Sales today" value={s ? formatGbp(s.today.sales) : "–"} sub="Food, delivery and tips" />
        <Tile label="Your commission today" value={s ? formatGbp(s.today.commission) : "–"} sub="Before ads" />
      </section>

      <section aria-labelledby="attention" className="rounded-2xl border border-zinc-200 bg-white p-5">
        <h2 id="attention" className="text-lg font-extrabold tracking-tight">
          Needs attention
        </h2>
        {listings.isLoading ? (
          <p className="mt-3 text-sm text-zinc-500">Loading…</p>
        ) : newApplications.length + waiting.length + hidden.length + offMap.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-zinc-300 p-5 text-center text-sm text-zinc-500">
            Nothing waiting. Every listed shop is approved and visible.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {newApplications.length > 0 && (
              <Attention
                title={`${newApplications.length} new shop ${newApplications.length === 1 ? "application" : "applications"}`}
                detail={newApplications.slice(0, 3).map((a) => a.businessName).join(", ")}
                href="/efl-console/applications"
                action="Review"
              />
            )}
            {waiting.map((l) => (
              <Attention
                key={`w-${l.id}`}
                title={`${l.shopName ?? "A shop"} is waiting for approval`}
                detail={l.town ?? ""}
                href="/efl-console/shops"
                action="Review"
              />
            ))}
            {hidden.map((l) => (
              <Attention
                key={`h-${l.id}`}
                tone="red"
                title={`${l.shopName ?? "A shop"} is ${l.status === "SUSPENDED" ? "suspended" : "hidden"}`}
                detail={l.hiddenReason === "HYGIENE" ? "Food hygiene rating below the minimum" : l.hiddenReason ?? "Suspended by the Console"}
                href="/efl-console/shops"
                action="Open"
              />
            ))}
            {offMap.length > 0 && (
              <Attention
                title={`${offMap.length} listed ${offMap.length === 1 ? "shop isn't" : "shops aren't"} on the map yet`}
                detail="Customers can't find a shop without its location. Place them from Shops."
                href="/efl-console/shops"
                action="Fix"
              />
            )}
          </ul>
        )}
      </section>
    </>
  );
}

function Tile({ label, value, sub, dark }: { label: string; value: string; sub?: string; dark?: boolean }) {
  return (
    <div
      className={
        "flex flex-col gap-1.5 rounded-2xl p-4 sm:p-5 " +
        (dark ? "bg-[#0B0B0B] text-white" : "border border-zinc-200 bg-white")
      }
    >
      <span className={"text-[13px] font-semibold " + (dark ? "text-zinc-300" : "text-zinc-600")}>{label}</span>
      <span className="text-3xl font-extrabold tabular-nums tracking-tight">{value}</span>
      {sub && <span className={"text-xs " + (dark ? "font-semibold text-[#D4FF3F]" : "text-zinc-500")}>{sub}</span>}
    </div>
  );
}

function Attention({
  title,
  detail,
  href,
  action,
  tone,
}: {
  title: string;
  detail: string;
  href: string;
  action: string;
  tone?: "red";
}) {
  return (
    <li
      className={
        "flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3.5 " +
        (tone === "red" ? "border-red-200 bg-red-50/40" : "border-zinc-200")
      }
    >
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-bold">{title}</span>
        {detail && <span className="text-[13px] text-zinc-600">{detail}</span>}
      </span>
      <Link
        href={href}
        className="inline-flex h-9 items-center rounded-lg bg-[#0B0B0B] px-3.5 text-xs font-bold text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/30"
      >
        {action}
      </Link>
    </li>
  );
}
