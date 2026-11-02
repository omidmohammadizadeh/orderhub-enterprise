"use client";

// Admin Dashboard → Food hygiene.
//
// One switch per location for the storefront's FSA hygiene badge. Switching a
// shop on that isn't linked yet finds its FSA record by name at its postcode;
// switching off only hides the badge (the link and nightly re-check stay).

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, RefreshCw, ShieldCheck, Search } from "lucide-react";
import toast from "react-hot-toast";
import { hygieneAdminClient, type HygieneAdminRow } from "@/lib/api/hygiene-admin.client";

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
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 ${
        checked ? "bg-green-600" : "bg-zinc-200"
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

function ratingLabel(r: HygieneAdminRow) {
  if (!r.fsaId) return "Not linked to the FSA yet";
  const date = r.ratingDate
    ? new Date(r.ratingDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : null;
  const rating = /^\d$/.test(r.rating ?? "") ? `${r.rating} / 5` : r.rating || "No rating yet";
  return date ? `${rating} · rated ${date}` : rating;
}

export function HygieneAdminPanel() {
  const [rows, setRows] = useState<HygieneAdminRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      setRows(await hygieneAdminClient.list());
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Couldn't load locations.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const replace = (saved: HygieneAdminRow) =>
    setRows((prev) => (prev ?? []).map((r) => (r.locationId === saved.locationId ? saved : r)));

  async function toggle(row: HygieneAdminRow, next: boolean) {
    setBusy(row.locationId);
    try {
      const saved = await hygieneAdminClient.setEnabled(row.locationId, next);
      replace(saved);
      toast.success(next ? `${row.locationName}: hygiene rating shown` : `${row.locationName}: hygiene rating hidden`);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't save.");
    } finally {
      setBusy(null);
    }
  }

  async function refresh(row: HygieneAdminRow) {
    setBusy(row.locationId);
    try {
      replace(await hygieneAdminClient.refresh(row.locationId));
      toast.success(`${row.locationName}: rating re-checked`);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't refresh.");
    } finally {
      setBusy(null);
    }
  }

  async function linkAll() {
    setBusy("__all");
    try {
      const res = await hygieneAdminClient.linkAll();
      toast.success(`Linked ${res.linked} shop${res.linked === 1 ? "" : "s"}; ${res.notFound} not found`);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't search the FSA.");
    } finally {
      setBusy(null);
    }
  }

  if (!rows && !error) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading locations…
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const visible = (rows ?? []).filter(
    (r) => !q || `${r.locationName} ${r.brandName ?? ""} ${r.postcode ?? ""}`.toLowerCase().includes(q),
  );
  const showingCount = (rows ?? []).filter((r) => r.showing).length;

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-2">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-zinc-700" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-zinc-900">Food hygiene</h1>
        </div>
        <p className="text-sm leading-relaxed text-zinc-500">
          Show each shop&apos;s Food Standards Agency hygiene rating on its storefront and restaurant
          app. Ratings are re-checked with the FSA every night, so a new inspection shows up by itself.
        </p>
        <p className="text-sm leading-relaxed text-zinc-500">
          Switching a shop on finds its FSA record by name at its postcode. If it can&apos;t be found,
          paste the ratings.food.gov.uk link in the location&apos;s settings (General → Food hygiene rating).
        </p>
      </header>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {rows && (
        <div className="rounded-xl border border-zinc-200">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 px-4 py-2.5">
            <h2 className="text-[13px] font-semibold text-zinc-700">
              Showing on {showingCount} of {rows.length} locations
            </h2>
            <div className="flex items-center gap-2">
              <label className="relative">
                <span className="sr-only">Search locations</span>
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search"
                  className="h-8 w-40 rounded-md border border-zinc-200 pl-7 pr-2 text-sm focus:border-zinc-400 focus:outline-none"
                />
              </label>
              <button
                type="button"
                onClick={linkAll}
                disabled={busy !== null}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                {busy === "__all" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                Find all automatically
              </button>
            </div>
          </div>
          {visible.length === 0 ? (
            <p className="px-4 py-6 text-sm text-zinc-400">No locations match.</p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {visible.map((r) => (
                <li key={r.locationId} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-900">{r.locationName}</p>
                    <p className="truncate text-xs text-zinc-500">
                      {[r.postcode, ratingLabel(r)].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {r.fsaId && (
                      <>
                        <a
                          href={`https://ratings.food.gov.uk/business/${r.fsaId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded p-1 text-zinc-400 hover:text-zinc-700"
                          aria-label={`Open ${r.locationName} on the FSA website`}
                        >
                          <ExternalLink className="h-4 w-4" aria-hidden="true" />
                        </a>
                        <button
                          type="button"
                          onClick={() => refresh(r)}
                          disabled={busy !== null}
                          className="rounded p-1 text-zinc-400 hover:text-zinc-700 disabled:opacity-50"
                          aria-label={`Re-check ${r.locationName} with the FSA`}
                        >
                          <RefreshCw className={`h-4 w-4 ${busy === r.locationId ? "animate-spin" : ""}`} aria-hidden="true" />
                        </button>
                      </>
                    )}
                    <Toggle
                      checked={r.showing}
                      disabled={busy !== null}
                      onChange={(v) => toggle(r, v)}
                      label={`Show the hygiene rating for ${r.locationName}`}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
