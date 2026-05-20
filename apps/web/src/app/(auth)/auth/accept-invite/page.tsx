"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import axios from "axios";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";

// Suspense wrapper required by Next.js 15 because useSearchParams() suspends
// during static generation unless the consumer is inside a Suspense boundary.
export default function AcceptInvitePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <div className="h-6 w-6 rounded-full border-2 border-zinc-200 border-t-orange-500 animate-spin" />
      </div>
    }>
      <AcceptInvitePageInner />
    </Suspense>
  );
}

function AcceptInvitePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError("No invite token found. Please check your invite link.");
    }
  }, [token]);

  const acceptMutation = useMutation({
    mutationFn: () =>
      axios
        .post(`${API_BASE}/v1/users/invite/accept`, { token, password })
        .then((r) => r.data),
    onSuccess: () => {
      router.push("/login?invited=1");
    },
    onError: (err: any) => {
      setError(err?.response?.data?.message ?? "Failed to activate account. The invite link may have expired.");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    acceptMutation.mutate();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-semibold text-zinc-900">Create your password</h1>
          <p className="text-sm text-zinc-500">
            You&apos;ve been invited to join OrderHub. Set a password to get started.
          </p>
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {!error || acceptMutation.isError ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">
                New password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                placeholder="At least 8 characters"
                minLength={8}
                required
                autoFocus
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">
                Confirm password
              </label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                placeholder="Repeat your password"
                required
              />
            </div>

            <button
              type="submit"
              disabled={acceptMutation.isPending || !token}
              className="w-full rounded-lg bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white font-medium py-2.5 text-sm transition-colors"
            >
              {acceptMutation.isPending ? "Activating account…" : "Activate account"}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
