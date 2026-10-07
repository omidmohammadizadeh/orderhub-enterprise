"use client";

// Admin Dashboard → Website showcase.
//
// Picks the brands on the homepage's "Trusted by" wall. Shown brands sit at the
// top in display order; everything else is below, busiest first, with a Live
// badge so it's obvious who is actually trading. A brand without a logo can be
// switched on but won't render until it has one — flagged inline.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Globe, ImageOff, Loader2, Search, Sparkles } from "lucide-react";
import toast from "react-hot-toast";
import {
  websiteShowcaseClient,
  type ShowcaseAdminRow,
} from "@/lib/api/website-showcase.client";

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
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 ${
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

export function WebsiteShowcasePanel() {
  const [rows, setRows] = useState<ShowcaseAdminRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      setRows(await websiteShowcaseClient.list());
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Couldn't load brands.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function replace(saved: ShowcaseAdminRow) {
    setRows((prev) => (prev ?? []).map((r) => (r.brandId === saved.brandId ? saved : r)));
  }

  async function toggle(row: ShowcaseAdminRow, next: boolean) {
    setBusy(row.brandId);
    try {
      replace(await websiteShowcaseClient.set(row.brandId, next));
      toast.success(next ? `${row.brandName} is on the homepage` : `${row.brandName} removed`);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't save.");
    } finally {
      setBusy(null);
    }
  }

  async function saveOrder(row: ShowcaseAdminRow, raw: string) {
    const n = raw.trim() === "" ? null : Math.max(0, Math.floor(Number(raw)));
    if (n !== null && !Number.isFinite(n)) return;
    if (n === row.showcaseOrder) return;
    setBusy(row.brandId);
    try {
      replace(await websiteShowcaseClient.set(row.brandId, row.showcaseOnWebsite, n));
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't save.");
    } finally {
      setBusy(null);
    }
  }

  async function featureLive() {
    setBusy("__all");
    try {
      const { featured } = await websiteShowcaseClient.featureLive();
      toast.success(
        featured
          ? `Featured ${featured} live brand${featured === 1 ? "" : "s"}`
          : "Every live brand with a logo is already featured",
      );
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Couldn't feature brands.");
    } finally {
      setBusy(null);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows ?? [];
    return (rows ?? []).filter((r) =>
      `${r.brandName} ${r.tenantName} ${r.city ?? ""}`.toLowerCase().includes(q),
    );
  }, [rows, query]);

  if (!rows && !error) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading brands…
      </div>
    );
  }

  const shown = filtered.filter((r) => r.showcaseOnWebsite);
  const hidden = filtered.filter((r) => !r.showcaseOnWebsite);
  const visibleOnSite = (rows ?? []).filter((r) => r.showcaseOnWebsite && r.logoUrl).length;
  const liveUnfeatured = (rows ?? []).filter(
    (r) => !r.showcaseOnWebsite && r.ordersLast30d > 0 && r.logoUrl,
  ).length;

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-2">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Globe className="h-5 w-5 text-zinc-700" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-zinc-900">Website showcase</h1>
        </div>
        <p className="text-sm leading-relaxed text-zinc-500">
          Brands switched on here appear with their logo in the &ldquo;Trusted
          by&rdquo; section of the homepage. Nothing appears unless you switch it
          on. Logos come from each brand&apos;s settings.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <a
            href="/#trusted"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-orange-600 hover:underline"
          >
            {visibleOnSite} on the homepage now <ExternalLink className="h-3 w-3" />
          </a>
          {liveUnfeatured > 0 && (
            <button
              type="button"
              onClick={featureLive}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {busy === "__all" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Feature all {liveUnfeatured} live brand{liveUnfeatured === 1 ? "" : "s"}
            </button>
          )}
        </div>
      </header>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {rows && (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search brands, merchants or cities"
              className="w-full rounded-lg border border-zinc-200 py-2 pl-9 pr-3 text-sm focus:border-zinc-400 focus:outline-none"
            />
          </div>

          <Section title={`On the homepage (${shown.length})`} empty="No brands featured yet.">
            {shown.map((r) => (
              <Row key={r.brandId} row={r} busy={busy} onToggle={toggle} onOrder={saveOrder} />
            ))}
          </Section>

          <Section title={`Not shown (${hidden.length})`} empty="Every brand is featured.">
            {hidden.map((r) => (
              <Row key={r.brandId} row={r} busy={busy} onToggle={toggle} onOrder={saveOrder} />
            ))}
          </Section>
        </>
      )}
    </div>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <div className="rounded-xl border border-zinc-200">
      <div className="border-b border-zinc-100 px-4 py-2.5">
        <h2 className="text-[13px] font-semibold text-zinc-700">{title}</h2>
      </div>
      {children.length === 0 ? (
        <p className="px-4 py-6 text-sm text-zinc-400">{empty}</p>
      ) : (
        <ul className="divide-y divide-zinc-100">{children}</ul>
      )}
    </div>
  );
}

function Row({
  row,
  busy,
  onToggle,
  onOrder,
}: {
  row: ShowcaseAdminRow;
  busy: string | null;
  onToggle: (row: ShowcaseAdminRow, next: boolean) => void;
  onOrder: (row: ShowcaseAdminRow, raw: string) => void;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-100 bg-white">
        {row.logoUrl ? (
          <img src={row.logoUrl} alt="" className="h-full w-full object-contain p-1" />
        ) : (
          <ImageOff className="h-4 w-4 text-zinc-300" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-sm font-medium text-zinc-900">
          {row.brandName}
          {row.ordersLast30d > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Live
            </span>
          )}
        </p>
        <p className="truncate text-xs text-zinc-500">
          {row.tenantName}
          {row.city ? ` · ${row.city}` : ""}
          {` · ${row.ordersLast30d} order${row.ordersLast30d === 1 ? "" : "s"} in 30 days`}
        </p>
        {row.showcaseOnWebsite && !row.logoUrl && (
          <p className="mt-0.5 text-xs text-amber-600">
            No logo — hidden until one is uploaded in the brand&apos;s settings.
          </p>
        )}
      </div>
      {row.showcaseOnWebsite && (
        <label className="flex items-center gap-1 text-[11px] text-zinc-400">
          Position
          <input
            type="number"
            min={0}
            defaultValue={row.showcaseOrder ?? ""}
            key={row.showcaseOrder ?? "none"}
            onBlur={(e) => onOrder(row, e.target.value)}
            disabled={busy !== null}
            className="w-14 rounded-md border border-zinc-200 px-1.5 py-1 text-xs text-zinc-700"
          />
        </label>
      )}
      <Toggle
        checked={row.showcaseOnWebsite}
        onChange={(v) => onToggle(row, v)}
        disabled={busy !== null}
        label={`Show ${row.brandName} on the homepage`}
      />
    </li>
  );
}
