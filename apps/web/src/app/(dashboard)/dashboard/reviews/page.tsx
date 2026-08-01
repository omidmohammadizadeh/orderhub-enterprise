"use client";

// Reviews left by customers on completed orders. Operators read them, reply
// publicly, and hide anything abusive.
//
// A reply is worth more than it looks: a considered response under a 2-star
// does more for a new customer than the 5-stars above it, so replying is the
// primary action on every card, not a hidden menu item.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Loader2, MessageSquare, Star } from "lucide-react";
import { reviewsClient, type Review } from "@/lib/api/reviews.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";

function Stars({ n, className = "h-4 w-4" }: { n: number; className?: string }) {
  return (
    <span className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={`${className} ${
            i <= n ? "fill-amber-400 text-amber-400" : "text-zinc-200"
          }`}
        />
      ))}
    </span>
  );
}

export default function ReviewsPage() {
  const qc = useQueryClient();
  const selectedLocationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const [filter, setFilter] = useState<number | null>(null);
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const query = useQuery({
    queryKey: ["reviews", selectedLocationId, filter],
    queryFn: () =>
      reviewsClient.list({
        locationId: selectedLocationId ?? undefined,
        rating: filter ?? undefined,
        limit: 200,
      }),
  });

  const reply = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      reviewsClient.reply(id, text),
    onSuccess: () => {
      setReplyingId(null);
      setDraft("");
      qc.invalidateQueries({ queryKey: ["reviews"] });
    },
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "PUBLISHED" | "HIDDEN" }) =>
      reviewsClient.setStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reviews"] }),
  });

  const reviews = query.data ?? [];
  // Summary is computed over everything loaded, so it must ignore the star
  // filter — otherwise filtering to 2 stars would claim your average is 2.0.
  const summary = useMemo(() => {
    if (filter) return null;
    if (!reviews.length) return null;
    const total = reviews.length;
    const sum = reviews.reduce((a, r) => a + r.rating, 0);
    return { average: Math.round((sum / total) * 10) / 10, total };
  }, [reviews, filter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Reviews</h1>
          <p className="text-sm text-zinc-500">
            What customers said about their orders — and your replies.
          </p>
        </div>
        {summary && (
          <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-2">
            <span className="text-2xl font-bold text-zinc-900">
              {summary.average}
            </span>
            <div>
              <Stars n={Math.round(summary.average)} className="h-3.5 w-3.5" />
              <p className="text-[11px] text-zinc-500">
                {summary.total} review{summary.total === 1 ? "" : "s"}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {[null, 5, 4, 3, 2, 1].map((n) => (
          <button
            key={n ?? "all"}
            onClick={() => setFilter(n)}
            className={
              "rounded-full border px-3 py-1.5 text-xs font-semibold " +
              (filter === n
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-200 text-zinc-600 hover:border-zinc-300")
            }
          >
            {n ? `${n} star${n === 1 ? "" : "s"}` : "All"}
          </button>
        ))}
      </div>

      {query.isLoading ? (
        <p className="py-10 text-center text-sm text-zinc-400">Loading…</p>
      ) : reviews.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 px-4 py-12 text-center">
          <MessageSquare className="mx-auto mb-2 h-6 w-6 text-zinc-300" />
          <p className="text-sm font-medium text-zinc-700">No reviews yet</p>
          <p className="mt-1 text-xs text-zinc-500">
            Customers can leave a review from their order history once an order
            is complete.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {reviews.map((r: Review) => (
            <article
              key={r.id}
              className={
                "rounded-lg border bg-white p-4 " +
                (r.status === "HIDDEN"
                  ? "border-zinc-200 opacity-60"
                  : "border-zinc-200")
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <Stars n={r.rating} />
                <span className="text-sm font-semibold text-zinc-900">
                  {r.customerName ?? "Customer"}
                </span>
                <span className="text-xs text-zinc-400">
                  {new Date(r.createdAt).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
                {r.status === "HIDDEN" && (
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-500">
                    Hidden
                  </span>
                )}
                <button
                  onClick={() =>
                    setStatus.mutate({
                      id: r.id,
                      status: r.status === "HIDDEN" ? "PUBLISHED" : "HIDDEN",
                    })
                  }
                  disabled={setStatus.isPending}
                  className="ml-auto inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
                >
                  {r.status === "HIDDEN" ? (
                    <>
                      <Eye className="h-3 w-3" /> Show
                    </>
                  ) : (
                    <>
                      <EyeOff className="h-3 w-3" /> Hide
                    </>
                  )}
                </button>
              </div>

              {r.comment && (
                <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-700">
                  {r.comment}
                </p>
              )}

              {r.reply && replyingId !== r.id && (
                <div className="mt-3 rounded-md border-l-2 border-zinc-900 bg-zinc-50 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                    Your reply
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700">
                    {r.reply}
                  </p>
                </div>
              )}

              {replyingId === r.id ? (
                <div className="mt-3">
                  <textarea
                    autoFocus
                    rows={3}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Thanks for the feedback…"
                    className="w-full rounded-md border border-zinc-200 p-2.5 text-sm outline-none focus:border-zinc-900"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      onClick={() => {
                        setReplyingId(null);
                        setDraft("");
                      }}
                      className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => reply.mutate({ id: r.id, text: draft })}
                      disabled={!draft.trim() || reply.isPending}
                      className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-40"
                    >
                      {reply.isPending && (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      )}
                      Publish reply
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setReplyingId(r.id);
                    setDraft(r.reply ?? "");
                  }}
                  className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-600 hover:text-zinc-900"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  {r.reply ? "Edit reply" : "Reply"}
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
