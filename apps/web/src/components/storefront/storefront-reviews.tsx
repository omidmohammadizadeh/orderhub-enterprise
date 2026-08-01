"use client";

// Reviews on the shop page — the half of the reviews feature that makes the
// other half worth having. Customers leave reviews from order history; without
// this they were only ever visible to the operator.
//
// Two pieces, used in different places on the storefront:
//   RatingPill      — compact "4.7 ★ (2.6k)" for the shop header
//   StorefrontReviews — the full section: average, star breakdown, review list
//
// Both render nothing at all when a shop has no reviews yet. A brand-new shop
// showing "0.0 ★ · No reviews" looks worse than showing no rating.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { reviewsClient } from "@/lib/api/reviews.client";

function Stars({ n, className = "h-3.5 w-3.5" }: { n: number; className?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={
            className +
            " " +
            (i <= Math.round(n)
              ? "fill-amber-400 text-amber-400"
              : "fill-zinc-200 text-zinc-200")
          }
        />
      ))}
    </span>
  );
}

/** Compact count: 2625 → "2.6k" so the header pill stays narrow. */
function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function useReviews(brandId?: string, locationId?: string, limit = 50) {
  return useQuery({
    queryKey: ["storefront-reviews", brandId ?? null, locationId ?? null, limit],
    queryFn: () => reviewsClient.publicList({ brandId, locationId, limit }),
    // Reviews change slowly; don't refetch on every tab focus.
    staleTime: 5 * 60_000,
    enabled: !!(brandId || locationId),
  });
}

export function RatingPill({
  brandId,
  locationId,
  onClick,
}: {
  brandId?: string;
  locationId?: string;
  onClick?: () => void;
}) {
  const { data } = useReviews(brandId, locationId, 1);
  const s = data?.summary;
  if (!s || !s.total) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-sm hover:bg-zinc-100"
      title={`${s.total} review${s.total === 1 ? "" : "s"}`}
    >
      <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
      <span className="font-bold text-zinc-900">{s.average.toFixed(1)}</span>
      <span className="text-xs text-zinc-500">({compact(s.total)})</span>
    </button>
  );
}

export function StorefrontReviews({
  brandId,
  locationId,
}: {
  brandId?: string;
  locationId?: string;
}) {
  const { data, isLoading } = useReviews(brandId, locationId, 50);
  const [filter, setFilter] = useState<number | null>(null);

  const shown = useMemo(() => {
    const all = data?.reviews ?? [];
    return filter ? all.filter((r) => r.rating === filter) : all;
  }, [data, filter]);

  if (isLoading) return null;
  const s = data?.summary;
  if (!s || !s.total) return null;

  return (
    <section id="reviews" className="mt-6">
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Review list */}
        <div className="order-2 lg:order-1">
          <h2 className="mb-3 text-lg font-bold text-zinc-900">
            What customers say
          </h2>
          {shown.length === 0 ? (
            <p className="rounded-xl border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500">
              No {filter}-star reviews yet.
            </p>
          ) : (
            <div className="space-y-2">
              {shown.map((r) => (
                <article
                  key={r.id}
                  className="rounded-xl border border-zinc-200 bg-white p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-bold text-zinc-900">
                      {r.customerName || "Customer"}
                    </p>
                    <time className="text-[11px] text-zinc-400">
                      {new Date(r.createdAt).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </time>
                  </div>
                  <Stars n={r.rating} />
                  {r.comment && (
                    <p className="mt-2 text-sm leading-relaxed text-zinc-700">
                      {r.comment}
                    </p>
                  )}
                  {/* The operator's reply matters more than the review above it
                      when a new customer is deciding — give it real weight. */}
                  {r.reply && (
                    <div className="mt-3 rounded-lg border-l-2 border-zinc-900 bg-zinc-50 p-3">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">
                        Response from the restaurant
                      </p>
                      <p className="mt-1 text-sm text-zinc-700">{r.reply}</p>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>

        {/* Summary + star filter */}
        <aside className="order-1 lg:order-2">
          <div className="rounded-xl border border-zinc-200 bg-white p-5">
            <div className="text-center">
              <p className="text-4xl font-black text-zinc-900">
                {s.average.toFixed(1)}
              </p>
              <div className="mt-1 flex justify-center">
                <Stars n={s.average} className="h-4 w-4" />
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                {s.total} review{s.total === 1 ? "" : "s"}
              </p>
              {s.average >= 4.5 && (
                <p className="mt-1 text-sm font-bold text-emerald-600">
                  Highly rated
                </p>
              )}
            </div>
            <div className="mt-4 space-y-1.5 border-t border-zinc-100 pt-4">
              <button
                type="button"
                onClick={() => setFilter(null)}
                className={
                  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs " +
                  (filter === null ? "bg-zinc-100 font-bold" : "hover:bg-zinc-50")
                }
              >
                All reviews
              </button>
              {[5, 4, 3, 2, 1].map((star) => {
                const count = s.breakdown?.[star] ?? 0;
                const pct = s.total ? (count / s.total) * 100 : 0;
                return (
                  <button
                    key={star}
                    type="button"
                    disabled={!count}
                    onClick={() => setFilter(star)}
                    className={
                      "flex w-full items-center gap-2 rounded-md px-2 py-1 disabled:opacity-40 " +
                      (filter === star ? "bg-zinc-100" : "hover:bg-zinc-50")
                    }
                  >
                    <span className="w-3 text-xs text-zinc-600">{star}</span>
                    <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100">
                      <span
                        className="block h-full rounded-full bg-amber-400"
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                    <span className="w-8 text-right text-[11px] text-zinc-500">
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
