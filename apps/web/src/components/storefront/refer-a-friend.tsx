"use client";

// Refer a friend — a hanging sign, and the sheet behind it.
//
// Unlike the loyalty card, this one IS meant to be seen. A stamp card is
// private to the person holding it; a referral only works if somebody notices
// it and tells someone else.
//
// The sign swings once on arrival and then hangs still. A permanently
// swinging thing at the edge of a menu is the same as a blinking banner —
// after ten seconds it stops meaning anything and starts being in the way.
// It picks up a nudge on hover and on tap, so it stays alive to touch without
// ever moving on its own again.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import { Check, Copy, Share2, Users, X } from "lucide-react";
import { formatMoney } from "@orderhub/shared";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

interface CodeState {
  active: boolean;
  code?: string;
  referrerAmount?: number;
  friendAmount?: number;
  minimumSpend?: number | null;
  qualified?: number;
  pending?: number;
  remaining?: number;
}

export function ReferAFriend({
  locationId,
  brandName,
  shareUrl,
  currency,
  token,
}: {
  locationId?: string | null;
  brandName?: string | null;
  shareUrl: string;
  currency: string;
  /** The customer's token. Signed out, there is no code to give them. */
  token?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Minted on first ask, so a customer who never opens this never gets a code
  // and the table stays the size of the people actually using it.
  const { data } = useQuery<CodeState>({
    queryKey: ["referral-code", locationId],
    enabled: !!locationId && !!token && open,
    queryFn: () =>
      axios
        .get(`${API_BASE}/v1/loyalty/referral-code`, {
          params: { locationId },
          headers: { Authorization: `Bearer ${token}` },
        })
        .then((r) => r.data),
  });

  // Whether the shop runs referrals at all — asked without the sheet being
  // open, because it decides whether the sign appears.
  const { data: peek } = useQuery<CodeState>({
    queryKey: ["referral-peek", locationId],
    enabled: !!locationId && !!token,
    queryFn: () =>
      axios
        .get(`${API_BASE}/v1/loyalty/referral-code`, {
          params: { locationId },
          headers: { Authorization: `Bearer ${token}` },
        })
        .then((r) => r.data),
  });

  const live = peek?.active === true;
  const card = data ?? peek;
  const friendAmount = card?.friendAmount ?? 0;
  const referrerAmount = card?.referrerAmount ?? 0;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  if (!live) return null;

  const link = card?.code
    ? `${shareUrl}${shareUrl.includes("?") ? "&" : "?"}ref=${card.code}`
    : shareUrl;

  const share = async () => {
    const text = `Order from ${brandName ?? "us"} with my code ${card?.code} and get ${formatMoney(friendAmount, currency)} off your first order.`;
    try {
      if (navigator.share) {
        await navigator.share({ title: brandName ?? "", text, url: link });
        return;
      }
    } catch {
      /* dismissed the share sheet — fall through to copying */
    }
    try {
      await navigator.clipboard.writeText(`${text} ${link}`);
      setCopied(true);
    } catch {
      /* clipboard blocked; the code is on screen and selectable */
    }
  };

  return (
    <>
      <style jsx global>{`
        @keyframes oh-swing {
          0% {
            transform: rotate(0deg);
          }
          20% {
            transform: rotate(7deg);
          }
          40% {
            transform: rotate(-5deg);
          }
          60% {
            transform: rotate(3deg);
          }
          80% {
            transform: rotate(-1.5deg);
          }
          100% {
            transform: rotate(0deg);
          }
        }
        .oh-sign {
          transform-origin: top center;
          animation: oh-swing 2.2s cubic-bezier(0.36, 0, 0.28, 1) 0.6s both;
        }
        .oh-sign:hover,
        .oh-sign:active {
          animation: oh-swing 1.4s cubic-bezier(0.36, 0, 0.28, 1) both;
        }
        @media (prefers-reduced-motion: reduce) {
          .oh-sign {
            animation: none !important;
          }
        }
      `}</style>

      {/* The sign. Hung from a little bar, like a shop sign — which is what
          makes it read as something to look at rather than another button. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mx-auto mt-2 flex w-full max-w-md flex-col items-center"
      >
        <span className="h-3 w-px bg-zinc-300" />
        <span className="oh-sign flex items-center gap-2.5 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 px-4 py-2.5 shadow-lg">
          <Users className="h-4 w-4 shrink-0 text-white" />
          <span className="text-[13px] font-bold text-white">
            Refer a friend, get{" "}
            {formatMoney(referrerAmount, currency)} off
          </span>
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-t-3xl bg-white p-6 sm:rounded-3xl">
            <div className="flex items-start justify-between">
              <h2 className="text-xl font-black tracking-tight text-zinc-900">
                Refer a friend
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Three steps, in order, in plain words. The thing people get
                wrong about referral schemes is when they get paid — so that
                is the step that says it explicitly. */}
            <ol className="mt-4 space-y-3">
              <Step n={1}>Share your code with a friend.</Step>
              <Step n={2}>
                They order for the first time
                {card?.minimumSpend
                  ? `, spending ${formatMoney(card.minimumSpend, currency)} or more`
                  : ""}
                .
              </Step>
              <Step n={3}>
                <strong className="text-zinc-900">
                  {formatMoney(referrerAmount, currency)} lands on your card
                </strong>{" "}
                and {formatMoney(friendAmount, currency)} on theirs, once their
                order is complete.
              </Step>
            </ol>

            <div className="mt-5 rounded-2xl border-2 border-dashed border-zinc-300 p-4 text-center">
              <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-400">
                Your code
              </p>
              <p className="mt-1 font-mono text-3xl font-black tracking-[0.2em] text-zinc-900">
                {card?.code ?? "…"}
              </p>
            </div>

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={share}
                disabled={!card?.code}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 py-3 text-sm font-bold text-white disabled:opacity-40"
              >
                <Share2 className="h-4 w-4" />
                Share
              </button>
              <button
                type="button"
                disabled={!card?.code}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(card!.code!);
                    setCopied(true);
                  } catch {
                    /* clipboard blocked; the code is on screen */
                  }
                }}
                className="flex items-center justify-center gap-2 rounded-xl border border-zinc-300 px-4 py-3 text-sm font-bold text-zinc-700 disabled:opacity-40"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-emerald-600" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>

            {/* Both counts, because "3 friends joined" and "2 have not ordered
                yet" are different facts and the second explains the wait. */}
            {(card?.qualified || card?.pending) ? (
              <p className="mt-4 text-center text-xs text-zinc-500">
                {card.qualified ?? 0} friend
                {(card.qualified ?? 0) === 1 ? "" : "s"} ordered
                {card.pending ? ` · ${card.pending} yet to order` : ""}
                {typeof card.remaining === "number"
                  ? ` · ${card.remaining} left to give`
                  : ""}
              </p>
            ) : null}

            <p className="mt-3 text-center text-[11px] leading-snug text-zinc-400">
              For friends ordering with us for the first time. Rewards land once
              their order is complete.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-[11px] font-bold text-white">
        {n}
      </span>
      <span className="text-sm leading-relaxed text-zinc-600">{children}</span>
    </li>
  );
}
