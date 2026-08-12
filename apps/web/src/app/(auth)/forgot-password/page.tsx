"use client";

// "I've forgotten my password."
//
// The confirmation is deliberately the same whether or not that address has an
// account — matching the API, which is where it actually matters. Telling
// someone "no account with that email" here would let anyone test a list of
// addresses against our customer base, and the honest version costs a real
// user nothing: if they mistyped, no email arrives and they try again.

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, MailCheck } from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { AuthShell } from "@/components/auth/auth-shell";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      await apiClient.post("/v1/auth/forgot-password", { email });
      setSent(true);
    } catch (err: any) {
      // Only genuine failures land here — a rate limit or the API being down.
      // "No such account" is not one of them, by design.
      setError(
        err?.response?.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : (err?.response?.data?.message ??
            "Couldn't send the email just now. Please try again."),
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <AuthShell
      title="Order Hub Solutions"
      subtitle={sent ? "Check your email" : "Reset your password"}
    >
      {sent ? (
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
            <MailCheck className="h-6 w-6 text-emerald-600" />
          </div>
          <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-zinc-500">
            If <span className="font-medium text-zinc-700">{email}</span> has an
            Order Hub account, a reset link is on its way. It expires in an hour
            and can only be used once.
          </p>
          <p className="mt-4 text-xs text-zinc-400">
            Nothing arrived? Check your spam folder, or{" "}
            <button
              onClick={() => setSent(false)}
              className="font-medium text-zinc-600 underline hover:text-zinc-900"
            >
              try a different address
            </button>
            .
          </p>
          <Link
            href="/login"
            className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-900"
          >
            <ArrowLeft className="h-4 w-4" /> Back to sign in
          </Link>
        </div>
      ) : (
        <>
          <p className="text-sm text-zinc-500">
            Enter the email address you sign in with and we&apos;ll send you a
            link to choose a new password.
          </p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="email"
                className="text-sm font-medium text-zinc-700"
              >
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                autoFocus
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@restaurant.com"
                className="w-full rounded-lg border border-zinc-300 px-3 py-2.5 text-sm outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
              />
            </div>

            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={sending || !email}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-orange-500 py-3 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
            >
              {sending && <Loader2 className="h-4 w-4 animate-spin" />}
              Send reset link
            </button>
          </form>

          <Link
            href="/login"
            className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-zinc-500 hover:text-zinc-900"
          >
            <ArrowLeft className="h-4 w-4" /> Back to sign in
          </Link>
        </>
      )}
    </AuthShell>
  );
}