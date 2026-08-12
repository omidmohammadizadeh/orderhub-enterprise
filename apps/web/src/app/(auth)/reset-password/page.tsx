"use client";

// Where the emailed link lands: choose a new password.
//
// The link is checked BEFORE the form is shown. An expired or already-used
// link is far commoner than it sounds — reset mail sits in inboxes, gets
// forwarded, gets clicked twice — and letting someone type a new password
// twice only to be told the link died is a genuinely infuriating way to find
// out.

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, CheckCircle2, Eye, EyeOff, Loader2, TriangleAlert } from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { AuthShell } from "@/components/auth/auth-shell";

export const dynamic = "force-dynamic";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  );
}

function ResetPasswordInner() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") ?? "";

  const [checking, setChecking] = useState(true);
  const [valid, setValid] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setChecking(false);
      setValid(false);
      return;
    }
    apiClient
      .get(`/v1/auth/reset-password/check`, { params: { token } })
      .then((r) => !cancelled && setValid(!!r.data?.valid))
      .catch(() => {
        // The check itself failed — a blip, or the API briefly down. Show the
        // form rather than telling someone their link is dead when we don't
        // actually know. The reset endpoint is the authority and will refuse
        // it properly if it really has expired; being wrong in this direction
        // costs a typed password, being wrong the other way costs a link that
        // was perfectly good.
        if (!cancelled) setValid(true);
      })
      .finally(() => !cancelled && setChecking(false));
    return () => {
      cancelled = true;
    };
  }, [token]);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = password.length >= 8 && confirm === password && !saving;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await apiClient.post("/v1/auth/reset-password", {
        token,
        newPassword: password,
      });
      setDone(true);
      // Straight to sign-in after a beat. Every other session was just ended
      // server-side, so there is nowhere else useful to be.
      setTimeout(() => router.push("/login"), 2500);
    } catch (err: any) {
      setError(
        err?.response?.data?.message ??
          "Couldn't change your password. Please request a new link.",
      );
      setSaving(false);
    }
  };

  if (checking) {
    return (
      <AuthShell title="Order Hub Solutions" subtitle="Checking your link">
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
        </div>
      </AuthShell>
    );
  }

  if (!valid) {
    return (
      <AuthShell title="Order Hub Solutions" subtitle="Link expired">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
            <TriangleAlert className="h-6 w-6 text-amber-600" />
          </div>
          <p className="mx-auto max-w-xs text-sm leading-relaxed text-zinc-500">
            This reset link has expired or has already been used. Links last an
            hour and work once.
          </p>
          <Link
            href="/forgot-password"
            className="mt-6 inline-block w-full rounded-lg bg-orange-500 py-3 text-sm font-semibold text-white hover:bg-orange-600"
          >
            Send me a new link
          </Link>
          <Link
            href="/login"
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-zinc-500 hover:text-zinc-900"
          >
            <ArrowLeft className="h-4 w-4" /> Back to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell title="Order Hub Solutions" subtitle="Password changed">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
            <CheckCircle2 className="h-6 w-6 text-emerald-600" />
          </div>
          <p className="mx-auto max-w-xs text-sm leading-relaxed text-zinc-500">
            Your password has been changed and everywhere else you were signed
            in has been signed out. Taking you to sign in…
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Order Hub Solutions" subtitle="Choose a new password">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="password" className="text-sm font-medium text-zinc-700">
            New password
          </label>
          <div className="relative">
            <input
              id="password"
              type={show ? "text" : "password"}
              required
              autoFocus
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              className="w-full rounded-lg border border-zinc-300 px-3 py-2.5 pr-10 text-sm outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? "Hide password" : "Show password"}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {tooShort && (
            <p className="text-xs text-amber-600">
              A little longer — 8 characters or more.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="confirm" className="text-sm font-medium text-zinc-700">
            Confirm new password
          </label>
          <input
            id="confirm"
            type={show ? "text" : "password"}
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2.5 text-sm outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
          />
          {mismatch && (
            <p className="text-xs text-amber-600">
              These two don&apos;t match yet.
            </p>
          )}
        </div>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-orange-500 py-3 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Change password
        </button>

        <p className="text-center text-xs text-zinc-400">
          Changing your password signs you out everywhere else.
        </p>
      </form>
    </AuthShell>
  );
}
