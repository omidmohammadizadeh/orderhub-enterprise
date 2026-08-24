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
  // Where the shop has WhatsApp, the friend proves the number before anything
  // pays out — one tap, one pre-filled message, and it costs the shop nothing.
  const [verifyUrl, setVerifyUrl] = useState<string | null>(null);
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
        const v = (r.data as any)?.verification;
        if (v?.required && v.url) setVerifyUrl(v.url as string);
        setMessage({
          ok: true,
          text: v?.required
            ? "Code accepted. One tap to prove your number and it's yours."
            : "Code accepted. Your reward lands once your first order is complete.",
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

  if (verifyUrl && message.ok) {
    return (
      <div className="mx-4 mt-3 rounded-xl bg-emerald-50 p-4 ring-1 ring-emerald-200">
        <div className="flex items-start gap-3">
          <Gift className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-emerald-900">
              Almost there
            </p>
            <p className="mt-0.5 text-sm leading-relaxed text-emerald-800">
              Send us one WhatsApp message so we know the number is yours. It
              opens with the text already written — just hit send.
            </p>
            <a
              href={verifyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white"
            >
              Verify on WhatsApp
            </a>
          </div>
          <button
            type="button"
            onClick={() => setVerifyUrl(null)}
            className="shrink-0 rounded p-0.5 text-emerald-700 opacity-60 hover:opacity-100"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

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
