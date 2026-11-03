"use client";

// Confirming a mobile number, once per account: the shop and driver need a
// number that works, and the server won't take an order without one. A code
// by text, then done; the app and the website share the result.

import { useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { eflCustomerApi, EflApiError } from "@/lib/api/efl-customer";
import { FOCUS } from "../efl-styles";
import { useEflSession } from "./session";

export function PhoneCheck() {
  const { phoneVerified, phone, refresh } = useEflSession();
  const [number, setNumber] = useState(phone ?? "");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (phoneVerified) {
    return (
      <p className="m-0 flex items-center gap-2 text-[15px]">
        <CheckCircle2 aria-hidden="true" className="h-5 w-5 text-[#0B0B0B]" />
        Mobile confirmed{phone ? `: ${phone}` : ""}
      </p>
    );
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof EflApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await eflCustomerApi.startPhone(number.trim());
      setSentTo(res.phone);
      setCode("");
    });
  };

  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await eflCustomerApi.verifyPhone(code.trim());
      await refresh();
    });
  };

  const input = `min-h-[48px] w-full rounded-xl border border-[#D6D6D6] px-4 text-base ${FOCUS}`;
  const button = `efl-press flex min-h-[48px] shrink-0 items-center justify-center gap-2 rounded-full bg-[#0B0B0B] px-5 text-[15px] font-bold text-white disabled:opacity-50 ${FOCUS}`;

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-[#F7F7F7] p-4">
      {sentTo ? (
        <form onSubmit={verify} className="flex flex-col gap-2">
          <label htmlFor="efl-code" className="text-sm font-bold">
            Enter the code we texted to {sentTo}
          </label>
          <div className="flex gap-2">
            <input
              id="efl-code"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={8}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className={`${input} tracking-[0.3em]`}
            />
            <button type="submit" disabled={busy || code.length < 4} className={button}>
              {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
              Confirm
            </button>
          </div>
          <button
            type="button"
            onClick={() => setSentTo(null)}
            className={`efl-press min-h-[44px] self-start rounded-full text-sm font-bold underline underline-offset-4 ${FOCUS}`}
          >
            Use a different number
          </button>
        </form>
      ) : (
        <form onSubmit={send} className="flex flex-col gap-2">
          <label htmlFor="efl-phone" className="text-sm font-bold">
            Your mobile number
          </label>
          <p className="m-0 text-sm text-[#5E5E5E]">So the shop and your driver can reach you. We&rsquo;ll text you a code, once.</p>
          <div className="flex gap-2">
            <input
              id="efl-phone"
              required
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="07123 456789"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              className={input}
            />
            <button type="submit" disabled={busy || number.trim().length < 10} className={button}>
              {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
              Send code
            </button>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className="m-0 text-sm font-semibold text-[#9B1C1C]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
