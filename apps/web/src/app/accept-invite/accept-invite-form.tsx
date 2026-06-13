"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  MapPin,
  Building2,
} from "lucide-react";
import { teamClient, humaniseRole } from "@/lib/api/team.client";

export function AcceptInviteForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token") ?? "";

  const inviteQuery = useQuery({
    queryKey: ["invite", token],
    queryFn: () => teamClient.getInviteByToken(token),
    enabled: !!token,
    retry: false,
  });

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const accept = useMutation({
    mutationFn: async () => {
      setError(null);
      if (!firstName.trim() || !lastName.trim()) {
        throw new Error("Please enter your first and last name.");
      }
      if (password.length < 8) {
        throw new Error("Password must be at least 8 characters.");
      }
      if (password !== confirm) {
        throw new Error("Passwords don't match.");
      }
      await teamClient.acceptInvite(token, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        password,
      });
    },
    onSuccess: () => {
      router.push("/login?invited=1");
    },
    onError: (err: any) =>
      setError(
        err?.response?.data?.message ?? err?.message ?? "Accept failed.",
      ),
  });

  if (!token) {
    return (
      <Card>
        <ErrorBlock title="Missing invitation token">
          The link you used doesn't include an invitation token. Ask the
          person who invited you to resend.
        </ErrorBlock>
      </Card>
    );
  }
  if (inviteQuery.isLoading) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading invitation…
        </div>
      </Card>
    );
  }
  if (inviteQuery.isError) {
    const msg =
      (inviteQuery.error as any)?.response?.data?.message ??
      "This invitation is invalid or has expired.";
    return (
      <Card>
        <ErrorBlock title="Invitation unavailable">{msg}</ErrorBlock>
      </Card>
    );
  }

  const invite = inviteQuery.data!;
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "/api";
  const googleHref = `${apiBase.replace(/\/+$/, "")}/v1/auth/oauth/google?invite=${encodeURIComponent(token)}`;

  return (
    <Card>
      <div className="mb-5">
        <h1 className="text-xl font-bold text-zinc-900">
          You're invited to {invite.tenantName}
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          {invite.inviterName} invited <strong>{invite.email}</strong> to join
          as a <strong>{humaniseRole(invite.role)}</strong>.
        </p>
      </div>

      {/* Scope summary */}
      {(invite.locations.length > 0 || invite.brands.length > 0) && (
        <div className="mb-5 rounded-md bg-zinc-50 p-3 space-y-1.5 text-xs">
          {invite.locations.length > 0 && (
            <div className="flex flex-wrap items-start gap-2">
              <MapPin className="h-3.5 w-3.5 text-zinc-400 mt-0.5" />
              <div>
                <span className="font-semibold text-zinc-700">Locations:</span>{" "}
                <span className="text-zinc-600">
                  {invite.locations.map((l) => l.name).join(", ")}
                </span>
              </div>
            </div>
          )}
          {invite.brands.length > 0 && (
            <div className="flex flex-wrap items-start gap-2">
              <Building2 className="h-3.5 w-3.5 text-zinc-400 mt-0.5" />
              <div>
                <span className="font-semibold text-zinc-700">Brands:</span>{" "}
                <span className="text-zinc-600">
                  {invite.brands.map((b) => b.name).join(", ")}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Google sign-in skip */}
      <a
        href={googleHref}
        className="mb-3 flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden>
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.99.66-2.26 1.05-3.72 1.05-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" fill="#34A853"/>
          <path d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.94l3.66-2.84Z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.07.56 4.21 1.64l3.15-3.15C17.45 2.1 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" fill="#EA4335"/>
        </svg>
        Continue with Google
      </a>

      <div className="my-4 flex items-center gap-2 text-xs text-zinc-400">
        <div className="flex-1 border-t border-zinc-200" />
        or create a password
        <div className="flex-1 border-t border-zinc-200" />
      </div>

      {/* Password form */}
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="First name"
            value={firstName}
            onChange={setFirstName}
            autoComplete="given-name"
          />
          <Field
            label="Last name"
            value={lastName}
            onChange={setLastName}
            autoComplete="family-name"
          />
        </div>
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
        />
        <Field
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
        />

        {error && (
          <div className="flex items-start gap-2 rounded bg-red-50 px-3 py-2 text-xs text-red-700">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <button
          onClick={() => accept.mutate()}
          disabled={accept.isPending}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-violet-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {accept.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Accept invitation
        </button>
      </div>

      <p className="mt-4 text-center text-xs text-zinc-400">
        Expires {new Date(invite.expiresAt).toLocaleDateString()}
      </p>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
      {children}
    </div>
  );
}

function ErrorBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="text-center">
      <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-red-50">
        <AlertCircle className="h-6 w-6 text-red-600" />
      </div>
      <h1 className="text-lg font-semibold text-zinc-900">{title}</h1>
      <p className="mt-2 text-sm text-zinc-500">{children}</p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-zinc-600 mb-1">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
      />
    </div>
  );
}
