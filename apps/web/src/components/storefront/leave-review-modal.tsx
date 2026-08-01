"use client";

// Customer-facing review form, opened from a past order in order history.
//
// Deliberately tiny: a star row and an optional comment. Every extra required
// field costs responses, and a bare star rating is still worth having — the
// headline average is what a new customer actually reads.

import { useState } from "react";
import { Loader2, Star, X } from "lucide-react";
import { reviewsClient } from "@/lib/api/reviews.client";

const RATING_LABEL: Record<number, string> = {
  1: "Poor",
  2: "Not great",
  3: "OK",
  4: "Good",
  5: "Excellent",
};

export function LeaveReviewModal({
  orderId,
  merchantName,
  onClose,
  onSubmitted,
}: {
  orderId: string;
  merchantName: string;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [rating, setRating] = useState(0);
  // Highlight stars under the cursor without committing the value, so the row
  // reads like a rating control rather than five separate buttons.
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (!rating) return;
    setBusy(true);
    setErr(null);
    try {
      await reviewsClient.submit({ orderId, rating, comment: comment.trim() });
      setDone(true);
      onSubmitted();
      window.setTimeout(onClose, 1600);
    } catch (e: any) {
      setErr(
        e?.response?.data?.message ??
          "Couldn't save your review. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const shown = hover || rating;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {done ? (
          <div className="py-8 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-50">
              <Star className="h-6 w-6 fill-green-600 text-green-600" />
            </div>
            <p className="text-base font-bold text-zinc-900">Thanks!</p>
            <p className="mt-1 text-sm text-zinc-500">
              Your review helps other customers.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-base font-bold text-zinc-900">
                  How was your order?
                </h2>
                <p className="mt-0.5 text-sm text-zinc-500">{merchantName}</p>
              </div>
              <button
                onClick={onClose}
                className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 flex flex-col items-center gap-2">
              <div className="flex gap-1" onMouseLeave={() => setHover(0)}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-label={`${n} star${n === 1 ? "" : "s"}`}
                    onMouseEnter={() => setHover(n)}
                    onClick={() => setRating(n)}
                    className="p-1"
                  >
                    <Star
                      className={
                        "h-9 w-9 transition-colors " +
                        (n <= shown
                          ? "fill-amber-400 text-amber-400"
                          : "text-zinc-300")
                      }
                    />
                  </button>
                ))}
              </div>
              <p className="h-4 text-xs font-medium text-zinc-500">
                {shown ? RATING_LABEL[shown] : "Tap to rate"}
              </p>
            </div>

            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Tell us more (optional)"
              className="mt-4 w-full rounded-lg border border-zinc-200 p-3 text-sm outline-none focus:border-zinc-900"
            />

            {err && <p className="mt-2 text-xs text-red-600">{err}</p>}

            <button
              onClick={submit}
              disabled={!rating || busy}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-900 py-3 text-sm font-bold text-white hover:bg-zinc-800 disabled:opacity-40"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Submit review
            </button>
            <p className="mt-2 text-center text-[11px] text-zinc-400">
              Shown publicly as your first name and last initial.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
