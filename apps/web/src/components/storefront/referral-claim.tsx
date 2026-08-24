"use client";

// A friend arriving on someone's ?ref= link.
//
// The code is remembered on arrival and claimed the moment they sign in,
// because the two things happen minutes apart: they land, browse a menu,
// build a basket, and only create an account at checkout. Holding the code in
// component state would lose it at the first navigation.
//
// It is claimed as soon as there is an account to attach it to, NOT at
// checkout. The friend should be told they qualify — or that they do not —
// while they can still do something about it, rather than discovering after
// paying that they were never eligible.

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import axios from "axios";
import { Gift, X } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";
const KEY = "orderhub.referral.pending";

export function ReferralClaim({
  locationId,
  token,
  customerId,
}: {
  locationId?: string | null;
  token?: string | null;
  customerId?: string | null;
}) {
  const ref = useSearchParams().get("ref");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  // Claimed once per mount. The effect below depends on values that change as
  // a session settles, and a second POST would just be a 400.
  const attempted = useRef(false);

  // Remember it immediately, whether or not they are signed in yet.
  useEffect(() => {
    if (!ref) return;
    try {
      window.sessionStorage.setItem(KEY, ref.trim().toUpperCase());
    } catch {
      /* private mode — they can still type the code at checkout */
    }
  }, [ref]);

  useEffect(() => {
    if (!token || !customerId || !locationId || attempted.current) return;
    let code: string | null = null;
    try {
      code = window.sessionStorage.getItem(KEY);
    } catch {
      code = ref;
    }
    if (!code) return;
    attempted.current = true;

    void axios
      .post(
        `${API_BASE}/v1/loyalty/referral-code/claim`,
        { locationId, code },
        { headers: { Authorization: `Bearer ${token}` } },
      )
      .then((r) => {
        try {
          window.sessionStorage.removeItem(KEY);
        } catch {
          /* nothing to clean up */
        }
        const amount = (r.data as any)?.friendAmount;
        setMessage({
          ok: true,
          text: amount
            ? `Code accepted. Your reward lands once your first order is complete.`
            : "Code accepted.",
        });
      })
      .catch((err) => {
        // Cleared either way: a code that was refused will be refused again,
        // and re-asking on every page view would be nagging.
        try {
          window.sessionStorage.removeItem(KEY);
        } catch {
          /* nothing to clean up */
        }
        setMessage({
          ok: false,
          text:
            (err as any)?.response?.data?.message ??
            "That referral code could not be used.",
        });
      });
  }, [token, customerId, locationId, ref]);

  if (!message) return null;

  return (
    <div
      className={`mx-4 mt-3 flex items-start gap-3 rounded-xl p-3 text-sm ${
        message.ok
          ? "bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200"
          : "bg-amber-50 text-amber-900 ring-1 ring-amber-200"
      }`}
    >
      <Gift className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="flex-1 leading-relaxed">{message.text}</span>
      <button
        type="button"
        onClick={() => setMessage(null)}
        className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
