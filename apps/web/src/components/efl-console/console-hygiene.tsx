"use client";

// Console → Food hygiene. Ratings come from the Food Standards Agency and are
// re-checked every night at 3am. A shop below the minimum is hidden from the
// app automatically and comes back when it improves. A shop is only checked
// once it is linked to its FSA record.

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { eflAdminClient, type EflHygieneShop } from "@/lib/api/efl.client";

export function ConsoleHygiene() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ["efl-admin", "hygiene"], queryFn: eflAdminClient.hygiene });
  const checkNow = useMutation({
    mutationFn: eflAdminClient.hygieneCheckNow,
    onSuccess: (r) => {
      toast.success(`Checked ${r.checked}: ${r.hidden} hidden, ${r.restored} back in the app`);
      qc.invalidateQueries({ queryKey: ["efl-admin"] });
    },
    onError: () => toast.error("Couldn't run the check"),
  });

  const shops = data.data?.shops ?? [];
  const hiddenCount = shops.filter((s) => s.hiddenForHygiene).length;

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-extrabold tracking-tight">Food hygiene</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-zinc-600">
            Ratings come from the Food Standards Agency and are re-checked every night at 3am. Shops below your minimum
            are hidden automatically and come back when they improve.
          </p>
        </div>
        <button
          type="button"
          onClick={() => checkNow.mutate()}
          disabled={checkNow.isPending}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#0B0B0B] px-4 text-sm font-bold text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {checkNow.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          Check all now
        </button>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl bg-[#0B0B0B] p-4 text-white">
          <p className="text-[13px] font-semibold text-zinc-300">Minimum rating</p>
          <p className="text-3xl font-extrabold text-[#D4FF3F]">{data.data?.minimum ?? "–"}</p>
          <Link href="/efl-console/settings" className="text-xs font-semibold text-zinc-300 underline underline-offset-2">
            Change in Settings
          </Link>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-4">
          <p className="text-[13px] font-semibold text-zinc-600">Hidden for hygiene</p>
          <p className="text-3xl font-extrabold tabular-nums">{data.isLoading ? "–" : hiddenCount}</p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-4">
          <p className="text-[13px] font-semibold text-zinc-600">Not linked to the FSA</p>
          <p className="text-3xl font-extrabold tabular-nums">
            {data.isLoading ? "–" : shops.filter((s) => !s.fsaEstablishmentId).length}
          </p>
        </div>
      </section>

      <section className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white">
        {data.isLoading ? (
          <p className="p-6 text-sm text-zinc-500">Loading…</p>
        ) : shops.length === 0 ? (
          <p className="p-8 text-center text-sm text-zinc-500">No shops on Eat For Less yet.</p>
        ) : (
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="text-xs font-bold text-zinc-500">
                <th className="px-4 py-3">Shop</th>
                <th className="px-4 py-3">Rating</th>
                <th className="px-4 py-3">Last checked</th>
                <th className="px-4 py-3">In the app</th>
                <th className="px-4 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shops.map((s) => (
                <HygieneRow key={s.listingId} shop={s} />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function HygieneRow({ shop }: { shop: EflHygieneShop }) {
  const qc = useQueryClient();
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("");
  const link = useMutation({
    mutationFn: (u?: string) => eflAdminClient.hygieneLink(shop.listingId, u),
    onSuccess: () => {
      toast.success("Linked and checked");
      setLinking(false);
      setUrl("");
      qc.invalidateQueries({ queryKey: ["efl-admin"] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.message ?? "Couldn't link"),
  });

  const numeric = shop.rating && /^\d$/.test(shop.rating);
  return (
    <tr className="border-t border-zinc-100 align-middle">
      <td className="px-4 py-3">
        <span className="block font-bold">{shop.shopName ?? "Unnamed shop"}</span>
        <span className="block text-xs text-zinc-500">{shop.town ?? "—"}</span>
      </td>
      <td className="px-4 py-3">
        {shop.rating ? (
          <span
            className={
              "inline-flex h-9 min-w-9 items-center justify-center rounded-full px-2 font-extrabold " +
              (shop.belowMinimum
                ? "bg-red-600 text-white"
                : numeric && Number(shop.rating) >= 3
                  ? "bg-[#0B0B0B] text-[#D4FF3F]"
                  : "bg-amber-100 text-amber-900")
            }
            title={shop.rating}
          >
            {numeric ? shop.rating : shop.rating.replace(/([a-z])([A-Z])/g, "$1 $2")}
          </span>
        ) : (
          <span className="text-xs text-zinc-500">{shop.fsaEstablishmentId ? "Not checked yet" : "Not linked"}</span>
        )}
      </td>
      <td className="px-4 py-3 text-zinc-700">
        {shop.checkedAt ? new Date(shop.checkedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—"}
      </td>
      <td className="px-4 py-3">
        <span
          className={
            "inline-flex rounded-lg px-2 py-1 text-xs font-extrabold " +
            (shop.hiddenForHygiene ? "bg-red-50 text-red-700" : "bg-[#D4FF3F] text-[#0B0B0B]")
          }
        >
          {shop.hiddenForHygiene ? "Hidden" : "Not hidden"}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        {shop.fsaEstablishmentId && !linking ? (
          <span className="inline-flex gap-2">
            <a
              href={`https://ratings.food.gov.uk/business/${shop.fsaEstablishmentId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1 rounded-lg bg-zinc-100 px-2.5 text-xs font-bold hover:bg-zinc-200"
            >
              FSA <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
            <button
              type="button"
              onClick={() => setLinking(true)}
              className="h-8 rounded-lg px-2.5 text-xs font-bold text-zinc-600 hover:bg-zinc-100"
            >
              Relink
            </button>
          </span>
        ) : linking || !shop.fsaEstablishmentId ? (
          <span className="inline-flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              disabled={link.isPending}
              onClick={() => link.mutate(undefined)}
              className="h-8 rounded-lg bg-[#0B0B0B] px-2.5 text-xs font-bold text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              Find by postcode
            </button>
            <label className="sr-only" htmlFor={`fsa-${shop.listingId}`}>
              FSA ratings link for {shop.shopName}
            </label>
            <input
              id={`fsa-${shop.listingId}`}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="or paste ratings.food.gov.uk link"
              className="h-8 w-56 rounded-lg border border-zinc-300 px-2 text-xs focus:border-[#0B0B0B] focus:outline-none"
            />
            <button
              type="button"
              disabled={!url || link.isPending}
              onClick={() => link.mutate(url)}
              className="h-8 rounded-lg bg-zinc-100 px-2.5 text-xs font-bold hover:bg-zinc-200 disabled:opacity-40"
            >
              Link
            </button>
          </span>
        ) : null}
      </td>
    </tr>
  );
}
