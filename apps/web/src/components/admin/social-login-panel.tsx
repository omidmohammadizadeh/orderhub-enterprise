"use client";

// Admin Dashboard → Social login.
//
// Per brand, which sign-in buttons its own app shows: Sign in with Apple and
// Google on iOS, Google on Android. The app reads this at launch, so it can be
// set before a store submission (and changed after) without a new build.
// Everything starts off. On iOS, Google needs Apple on too (App Store
// guideline 4.8) — the switch is locked until Apple is on, and turning Apple
// off turns iOS Google off with it.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Apple, ImageOff, Info, KeyRound, Loader2, Search, Smartphone } from "lucide-react";
import toast from "react-hot-toast";
import {
  socialLoginClient,
  type SocialLoginAdminRow,
  type SocialLoginFlags,
} from "@/lib/api/social-login.client";

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 ${
        checked ? "bg-emerald-500" : "bg-zinc-200"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.12-1.43.34-2.1V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.83Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.07l3.66 2.83C6.71 7.31 9.14 5.38 12 5.38Z" />
    </svg>
  );
}

export function SocialLoginPanel() {
  const [rows, setRows] = useState<SocialLoginAdminRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyApps, setOnlyApps] = useState(true);

  const load = useCallback(async () => {
    try {
      setRows(await socialLoginClient.list());
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Couldn't load brands.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(row: SocialLoginAdminRow, next: SocialLoginFlags) {
    setBusy(row.brandId);
    try {
      const saved = await socialLoginClient.set(row.brandId, next);
      setRows((prev) => (prev ?? []).map((r) => (r.brandId === saved.brandId ? saved : r)));
      toast.success(`Saved for ${row.brandName}`);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't save.");
    } finally {
      setBusy(null);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((r) => {
      const anyOn = r.ios.apple || r.ios.google || r.android.google;
      // A search looks through every brand; otherwise apps and configured ones.
      if (!q) return !onlyApps || r.appIds.length > 0 || anyOn;
      return `${r.brandName} ${r.tenantName} ${r.appIds.join(" ")}`.toLowerCase().includes(q);
    });
  }, [rows, query, onlyApps]);

  if (!rows && !error) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading brands…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 py-2">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-zinc-700" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-zinc-900">Social login</h1>
        </div>
        <p className="text-sm leading-relaxed text-zinc-500">
          Choose the sign-in buttons each restaurant app shows. The app checks this when it
          opens, so you can submit with or without social sign-in and change it later
          without a new build. Everything is off until you switch it on.
        </p>
        <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <div className="space-y-1">
            <p>
              <strong>iOS:</strong> Google can only be on with Sign in with Apple (App Store
              guideline 4.8). Turn both off to submit an app without social sign-in.
            </p>
            <p>
              A switch only shows a button the app&apos;s build can offer: Google needs the
              brand&apos;s OAuth client ids in the build, Apple needs the capability on the
              client&apos;s App ID (see apps/customer README → Sign-in setup).
            </p>
          </div>
        </div>
      </header>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {rows && (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search brands, merchants or app ids"
                className="w-full rounded-lg border border-zinc-200 py-2 pl-9 pr-3 text-sm focus:border-zinc-400 focus:outline-none"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-zinc-600">
              <input
                type="checkbox"
                checked={onlyApps}
                onChange={(e) => setOnlyApps(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-300"
              />
              Only brands with an app
            </label>
          </div>

          <div className="rounded-xl border border-zinc-200">
            <div className="hidden grid-cols-[1fr_auto_auto_auto] items-center gap-6 border-b border-zinc-100 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 md:grid">
              <span>Brand</span>
              <span className="w-16 text-center">iOS Apple</span>
              <span className="w-16 text-center">iOS Google</span>
              <span className="w-20 text-center">Android Google</span>
            </div>
            {filtered.length === 0 ? (
              <p className="px-4 py-6 text-sm text-zinc-400">
                {onlyApps && !query
                  ? "No brand has an app installed yet. Untick “Only brands with an app” or search to set one up ahead of launch."
                  : "No brands match."}
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {filtered.map((r) => (
                  <Row key={r.brandId} row={r} busy={busy === r.brandId} onSave={save} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Row({
  row,
  busy,
  onSave,
}: {
  row: SocialLoginAdminRow;
  busy: boolean;
  onSave: (row: SocialLoginAdminRow, next: SocialLoginFlags) => void;
}) {
  const flags: SocialLoginFlags = { ios: row.ios, android: row.android };
  const setIosApple = (apple: boolean) =>
    // Apple off takes iOS Google with it (4.8).
    onSave(row, { ...flags, ios: { apple, google: apple && row.ios.google } });
  const setIosGoogle = (google: boolean) => onSave(row, { ...flags, ios: { ...row.ios, google } });
  const setAndroidGoogle = (google: boolean) => onSave(row, { ...flags, android: { google } });

  return (
    <li className="grid grid-cols-1 gap-3 px-4 py-3 md:grid-cols-[1fr_auto_auto_auto] md:items-center md:gap-6">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-100 bg-white">
          {row.logoUrl ? (
            <img src={row.logoUrl} alt="" className="h-full w-full object-contain p-1" />
          ) : (
            <ImageOff className="h-4 w-4 text-zinc-300" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0">
          <p className="flex items-center gap-2 truncate text-sm font-medium text-zinc-900">
            {row.brandName}
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" aria-hidden="true" />}
          </p>
          <p className="truncate text-xs text-zinc-500">
            {row.tenantName}
            {row.appIds.length > 0 && (
              <>
                {" · "}
                <Smartphone className="inline h-3 w-3 align-[-2px]" aria-hidden="true" />{" "}
                {row.appIds.join(", ")}
              </>
            )}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 md:w-16 md:justify-center">
        <span className="flex items-center gap-1.5 text-xs text-zinc-600 md:hidden">
          <Apple className="h-3.5 w-3.5" aria-hidden="true" /> iOS · Sign in with Apple
        </span>
        <Toggle
          checked={row.ios.apple}
          onChange={setIosApple}
          disabled={busy}
          label={`${row.brandName}: Sign in with Apple on iOS`}
        />
      </div>
      <div className="flex items-center justify-between gap-2 md:w-16 md:justify-center">
        <span className="flex items-center gap-1.5 text-xs text-zinc-600 md:hidden">
          <GoogleMark /> iOS · Google
        </span>
        <span title={row.ios.apple ? undefined : "Turn on Sign in with Apple first (guideline 4.8)"}>
          <Toggle
            checked={row.ios.google}
            onChange={setIosGoogle}
            disabled={busy || !row.ios.apple}
            label={`${row.brandName}: Google sign-in on iOS`}
          />
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 md:w-20 md:justify-center">
        <span className="flex items-center gap-1.5 text-xs text-zinc-600 md:hidden">
          <GoogleMark /> Android · Google
        </span>
        <Toggle
          checked={row.android.google}
          onChange={setAndroidGoogle}
          disabled={busy}
          label={`${row.brandName}: Google sign-in on Android`}
        />
      </div>
    </li>
  );
}
