"use client";

// Console → Shops: every listing, and the platform's decisions about it —
// approval, suspension and commission. The shop's own settings (photo,
// description, delivery mode) stay the shop's, in OrderHub.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MapPin } from "lucide-react";
import toast from "react-hot-toast";
import { eflAdminClient, type EflAdminListing, type EflListingStatus } from "@/lib/api/efl.client";

type Filter = "all" | "waiting" | "live" | "off";

const FILTERS: Array<{ key: Filter; label: string; test: (l: EflAdminListing) => boolean }> = [
  { key: "all", label: "All", test: () => true },
  { key: "waiting", label: "Waiting", test: (l) => l.listed && l.status === "PENDING" },
  { key: "live", label: "Live", test: (l) => l.live },
  { key: "off", label: "Suspended or hidden", test: (l) => l.status === "SUSPENDED" || !!l.hiddenReason },
];

const DELIVERY_LABEL: Record<EflAdminListing["deliveryMode"], string> = {
  OWN_DRIVERS: "Own drivers",
  COURIER: "Courier",
  OWN_THEN_COURIER: "Own + courier",
};

export function ConsoleShops() {
  const qc = useQueryClient();
  const listings = useQuery({ queryKey: ["efl-admin", "listings"], queryFn: eflAdminClient.listings });
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo(
    () => (listings.data ?? []).filter(FILTERS.find((f) => f.key === filter)!.test),
    [listings.data, filter],
  );
  const selected = (listings.data ?? []).find((l) => l.id === selectedId) ?? rows[0] ?? null;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["efl-admin"] });
  };
  const placeOnMap = useMutation({
    mutationFn: eflAdminClient.placeOnMap,
    onSuccess: (r) => {
      toast.success(`Placed ${r.placed} of ${r.checked} shops on the map`);
      refresh();
    },
    onError: () => toast.error("Couldn't place shops on the map"),
  });

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-extrabold tracking-tight">Shops</h1>
          <p className="mt-1 text-[13px] text-zinc-600">
            A shop shows in the app when it has switched itself on in OrderHub and you have approved it.
          </p>
        </div>
        <button
          type="button"
          onClick={() => placeOnMap.mutate()}
          disabled={placeOnMap.isPending}
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-zinc-300 bg-white px-3.5 text-sm font-semibold hover:bg-zinc-50 disabled:opacity-50"
        >
          {placeOnMap.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <MapPin className="h-4 w-4" aria-hidden="true" />
          )}
          Place shops on the map
        </button>
      </header>

      <div role="tablist" aria-label="Filter shops" className="flex w-fit flex-wrap gap-1 rounded-xl bg-[#EAEAE6] p-1">
        {FILTERS.map((f) => {
          const count = (listings.data ?? []).filter(f.test).length;
          const on = filter === f.key;
          return (
            <button
              key={f.key}
              role="tab"
              aria-selected={on}
              type="button"
              onClick={() => setFilter(f.key)}
              className={
                "h-8 rounded-lg px-3 text-[13px] font-bold transition-colors " +
                (on ? "bg-white text-[#0B0B0B] shadow-sm" : "text-zinc-600 hover:text-[#0B0B0B]")
              }
            >
              {f.label} <span className="tabular-nums text-zinc-500">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <section className="min-w-0 flex-1 overflow-x-auto rounded-2xl border border-zinc-200 bg-white">
          {listings.isLoading ? (
            <p className="p-6 text-sm text-zinc-500">Loading shops…</p>
          ) : rows.length === 0 ? (
            <p className="p-8 text-center text-sm text-zinc-500">
              {listings.data?.length
                ? "No shops match this filter."
                : "No shop has switched Eat For Less on yet. Shops do it in OrderHub → Locations → Platforms."}
            </p>
          ) : (
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="text-xs font-bold text-zinc-500">
                  <th className="px-4 py-3">Shop</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Commission</th>
                  <th className="px-4 py-3">Delivery</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  const on = selected?.id === l.id;
                  return (
                    <tr
                      key={l.id}
                      onClick={() => setSelectedId(l.id)}
                      className={"cursor-pointer border-t border-zinc-100 " + (on ? "bg-[#F4F4F1]" : "hover:bg-[#FAFAF8]")}
                    >
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setSelectedId(l.id)}
                          className="text-left focus-visible:outline-none focus-visible:underline"
                        >
                          <span className="block font-bold">{l.shopName ?? "Unnamed shop"}</span>
                          <span className="block text-xs text-zinc-500">{l.town ?? "—"}</span>
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge listing={l} />
                      </td>
                      <td className="px-4 py-3 font-bold tabular-nums">
                        {l.commissionPercent}%
                        {l.commissionIsDefault && <span className="ml-1 text-xs font-medium text-zinc-500">default</span>}
                      </td>
                      <td className="px-4 py-3 text-zinc-700">{DELIVERY_LABEL[l.deliveryMode]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        {selected && <ShopDetail key={selected.id} listing={selected} onChanged={refresh} />}
      </div>
    </>
  );
}

function StatusBadge({ listing }: { listing: EflAdminListing }) {
  const [text, cls] = listing.live
    ? ["Live", "bg-[#D4FF3F] text-[#0B0B0B]"]
    : listing.status === "SUSPENDED"
      ? ["Suspended", "bg-red-50 text-red-700"]
      : listing.hiddenReason
        ? [
            listing.hiddenReason === "HYGIENE" ? "Hidden: hygiene" : listing.hiddenReason === "OFFLINE" ? "Offline" : "Hidden",
            "bg-red-50 text-red-700",
          ]
        : !listing.listed
          ? ["Switched off by shop", "bg-zinc-100 text-zinc-600"]
          : ["Waiting for you", "bg-[#0B0B0B] text-white"];
  return <span className={`inline-flex rounded-lg px-2 py-1 text-xs font-bold ${cls}`}>{text}</span>;
}

function ShopDetail({ listing, onChanged }: { listing: EflAdminListing; onChanged: () => void }) {
  const [pct, setPct] = useState<number>(listing.commissionPercent);
  const [useDefault, setUseDefault] = useState(listing.commissionIsDefault);
  useEffect(() => {
    setPct(listing.commissionPercent);
    setUseDefault(listing.commissionIsDefault);
  }, [listing.commissionPercent, listing.commissionIsDefault]);

  const update = useMutation({
    mutationFn: (patch: { status?: EflListingStatus; commissionPercent?: number | null; hiddenReason?: string | null }) =>
      eflAdminClient.updateListing(listing.id, patch),
    onSuccess: () => {
      toast.success("Saved");
      onChanged();
    },
    onError: (err: any) => toast.error(err?.response?.data?.message ?? "Couldn't save"),
  });

  const commissionDirty = useDefault !== listing.commissionIsDefault || (!useDefault && pct !== listing.commissionPercent);

  return (
    <aside className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-5 lg:w-80 lg:shrink-0">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.06em] text-zinc-500">Shop details</p>
        <p className="mt-1 text-xl font-extrabold tracking-tight">{listing.shopName ?? "Unnamed shop"}</p>
        <p className="text-[13px] text-zinc-600">
          {listing.town ?? "—"} · {listing.placedOnMap ? "on the map" : "not on the map yet"}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {listing.status !== "APPROVED" && (
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => update.mutate({ status: "APPROVED" })}
            className="h-11 rounded-xl bg-[#D4FF3F] text-sm font-extrabold text-[#0B0B0B] hover:brightness-95 disabled:opacity-50"
          >
            {listing.status === "SUSPENDED" ? "Reinstate" : "Approve and list"}
          </button>
        )}
        {listing.status === "APPROVED" && (
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => update.mutate({ status: "SUSPENDED" })}
            className="h-11 rounded-xl border border-red-200 bg-white text-sm font-bold text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            Suspend from the app
          </button>
        )}
        {listing.hiddenReason && (
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => update.mutate({ hiddenReason: null })}
            className="h-11 rounded-xl border border-zinc-300 text-sm font-bold hover:bg-zinc-50 disabled:opacity-50"
          >
            Show again now
          </button>
        )}
      </div>

      <fieldset className="flex flex-col gap-2.5 border-t border-zinc-100 pt-4">
        <legend className="text-sm font-bold">Commission for this shop</legend>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={useDefault}
            onChange={(e) => setUseDefault(e.target.checked)}
            className="h-4 w-4 accent-[#0B0B0B]"
          />
          Use the platform default
        </label>
        {!useDefault && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Lower commission"
              onClick={() => setPct((p) => Math.max(0, Math.round((p - 0.5) * 2) / 2))}
              className="h-10 w-10 rounded-full bg-zinc-100 text-lg font-extrabold hover:bg-zinc-200"
            >
              −
            </button>
            <span className="min-w-16 text-center text-3xl font-extrabold tabular-nums" aria-live="polite">
              {pct}%
            </span>
            <button
              type="button"
              aria-label="Raise commission"
              onClick={() => setPct((p) => Math.min(40, Math.round((p + 0.5) * 2) / 2))}
              className="h-10 w-10 rounded-full bg-zinc-100 text-lg font-extrabold hover:bg-zinc-200"
            >
              +
            </button>
          </div>
        )}
        <p className="text-xs text-zinc-500">
          Applies to new orders. Orders already placed keep the rate they were placed at.
        </p>
        <button
          type="button"
          disabled={!commissionDirty || update.isPending}
          onClick={() => update.mutate({ commissionPercent: useDefault ? null : pct })}
          className="h-10 rounded-xl bg-[#0B0B0B] text-sm font-bold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save commission
        </button>
      </fieldset>
    </aside>
  );
}
