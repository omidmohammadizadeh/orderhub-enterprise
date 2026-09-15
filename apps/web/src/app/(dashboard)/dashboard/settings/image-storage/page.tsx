"use client";

// Platform-admin maintenance: move images that are sitting in Postgres as
// base64 into Supabase Storage.
//
// This is a page rather than a CLI script because running the script means
// holding the Supabase service_role key — the credential that bypasses every
// row-level rule in the project — in a terminal. The API already has it.
//
// Design notes, so a later edit doesn't undo the point of it:
//   • The WEIGHT is the hero. The whole reason this screen exists is "how
//     much junk is in there", so the kilobytes are set large and tabular
//     rather than buried in a sentence.
//   • Consent is staged: "Move them" cannot be clicked until a check has run
//     and found something. Apply-by-accident on production data is the one
//     failure this screen must not allow.
//   • The ledger below is the receipt. Every row names the shop and says what
//     happened to it, because a migration you can't read is one you can't
//     check afterwards.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Database,
  HardDriveDownload,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Search,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { cn } from "@/lib/utils";

interface RehostRow {
  model: string;
  column: string;
  id: string;
  name: string;
  kilobytes: number;
  url?: string;
  error?: string;
}

interface RehostSummary {
  applied: boolean;
  moved: number;
  failed: number;
  kilobytes: number;
  remaining: number;
  rows: RehostRow[];
  configured: boolean;
}

/** Plain-English names for the columns, so the ledger doesn't read as schema. */
const WHERE: Record<string, string> = {
  "brand.logoUrl": "Brand logo",
  "location.logoUrl": "Shop logo",
  "menu.bannerImage": "Menu banner",
  "menu.heroImage": "Menu hero image",
  "menu.logoImage": "Menu logo",
  "menuItem.imageUrl": "Product photo",
  "modifierOption.imageUrl": "Modifier photo",
  "directOrderingConfig.heroImageUrl": "Storefront hero",
};

const label = (row: RehostRow) =>
  WHERE[`${row.model}.${row.column}`] ?? `${row.model} ${row.column}`;

/** KB below a megabyte, MB above it — nobody reads "703327KB". */
function weight(kb: number): { value: string; unit: string } {
  if (kb < 1024) return { value: String(kb), unit: "KB" };
  return { value: (kb / 1024).toFixed(1), unit: "MB" };
}

export default function ImageStoragePage() {
  const [checked, setChecked] = useState<RehostSummary | null>(null);
  const [result, setResult] = useState<RehostSummary | null>(null);

  const run = (apply: boolean) =>
    apiClient
      .post("/v1/uploads/rehost-inline-images", { apply, limit: apply ? 50 : 200 })
      .then((r) => r.data as RehostSummary);

  const check = useMutation({
    mutationFn: () => run(false),
    onSuccess: (data) => {
      setChecked(data);
      setResult(null);
    },
  });

  const move = useMutation({
    mutationFn: () => run(true),
    onSuccess: (data) => setResult(data),
  });

  const busy = check.isPending || move.isPending;
  const error =
    (check.error as any)?.response?.data?.message ??
    (move.error as any)?.response?.data?.message ??
    (check.error || move.error ? "Something went wrong. Try again." : null);

  // What the big number is showing right now: the result of a move if there
  // has been one, otherwise the check.
  const showing = result ?? checked;
  const w = weight(showing?.kilobytes ?? 0);
  const nothingToDo = !!showing && showing.moved === 0 && showing.failed === 0;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="flex items-center gap-2.5 text-xl font-semibold text-zinc-900">
          <Database className="h-5 w-5 text-zinc-400" aria-hidden="true" />
          Image storage
        </h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-zinc-600">
          Some pictures are stored inside the database instead of as a web
          address. Those get sent again on every single visit to the shop’s
          page, and WhatsApp and Facebook can’t use them for link
          previews. Moving them fixes both.
        </p>
      </header>

      {/* ── The measurement ─────────────────────────────────────────────── */}
      <section
        aria-live="polite"
        aria-busy={busy}
        className="rounded-xl border border-zinc-200 bg-white p-6"
      >
        {!showing && (
          <p className="text-sm text-zinc-500">
            Check to see how much is stored this way. Nothing changes until you
            say so.
          </p>
        )}

        {showing && showing.configured === false && (
          <div className="flex items-start gap-3 text-sm">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500"
              aria-hidden="true"
            />
            <p className="text-zinc-700">
              Image storage isn’t switched on for this server, so there is
              nowhere to move the pictures to. Set{" "}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-[13px]">
                SUPABASE_URL
              </code>{" "}
              and{" "}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-[13px]">
                SUPABASE_SERVICE_ROLE_KEY
              </code>{" "}
              on the API service first.
            </p>
          </div>
        )}

        {showing && showing.configured && nothingToDo && (
          <div className="flex items-center gap-3">
            <CheckCircle2
              className="h-5 w-5 flex-shrink-0 text-emerald-600"
              aria-hidden="true"
            />
            <p className="text-sm font-medium text-zinc-900">
              Nothing is stored in the database. Every picture is already a web
              address.
            </p>
          </div>
        )}

        {showing && showing.configured && !nothingToDo && (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-5xl font-semibold tabular-nums tracking-tight text-zinc-900">
              {w.value}
            </span>
            <span className="text-2xl font-medium text-zinc-400">{w.unit}</span>
            <p className="w-full pt-1 text-sm text-zinc-600">
              {showing.applied ? (
                <>
                  moved out of the database, across {showing.moved}{" "}
                  {showing.moved === 1 ? "picture" : "pictures"}.
                </>
              ) : (
                <>
                  sitting in the database, across {showing.moved}{" "}
                  {showing.moved === 1 ? "picture" : "pictures"}.
                </>
              )}
            </p>
          </div>
        )}

        {showing && showing.failed > 0 && (
          <p className="mt-4 flex items-start gap-2 text-sm text-zinc-700">
            <XCircle
              className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500"
              aria-hidden="true"
            />
            {showing.failed === 1
              ? "One picture couldn't be moved and was left exactly as it was. It still shows on the site."
              : `${showing.failed} pictures couldn't be moved and were left exactly as they were. They still show on the site.`}{" "}
            Try again later.
          </p>
        )}

        {showing?.applied && showing.remaining > 0 && (
          <p className="mt-4 flex items-start gap-2 text-sm text-zinc-700">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500"
              aria-hidden="true"
            />
            There are more still to move. Run it again to carry on — it picks up
            where it left off.
          </p>
        )}
      </section>

      {/* ── The two actions ─────────────────────────────────────────────── */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => check.mutate()}
          disabled={busy}
          className="inline-flex touch-manipulation items-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm font-medium text-zinc-800 transition-colors hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {check.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Search className="h-4 w-4" aria-hidden="true" />
          )}
          {check.isPending
            ? "Checking…"
            : checked
              ? "Check again"
              : "Check what’s stored"}
        </button>

        <button
          type="button"
          onClick={() => move.mutate()}
          // Staged consent: you cannot move anything you have not first been
          // shown. This is production data and the button is one click.
          disabled={busy || !checked?.configured || !checked || checked.moved === 0}
          className={cn(
            "inline-flex touch-manipulation items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors",
            "bg-zinc-900 text-white hover:bg-zinc-800",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900",
            "disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400",
          )}
        >
          {move.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <HardDriveDownload className="h-4 w-4" aria-hidden="true" />
          )}
          {move.isPending ? "Moving…" : "Move them to storage"}
        </button>

        {!checked && !busy && (
          <p className="text-sm text-zinc-500">Check first, then you can move them.</p>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {error}
        </p>
      )}

      {/* ── The ledger ──────────────────────────────────────────────────── */}
      {showing && showing.rows.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-zinc-900">
            {showing.applied ? "What moved" : "What would move"}
          </h2>
          <ul className="mt-3 divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white">
            {showing.rows.map((row) => (
              <li
                key={`${row.model}-${row.column}-${row.id}`}
                className="flex items-center gap-4 px-4 py-3 text-sm"
              >
                <span className="min-w-0 flex-1 truncate font-medium text-zinc-900">
                  {row.name}
                </span>
                <span className="hidden flex-shrink-0 text-zinc-500 sm:block">
                  {label(row)}
                </span>
                <span className="w-20 flex-shrink-0 text-right font-mono tabular-nums text-zinc-600">
                  {row.kilobytes} KB
                </span>
                <span className="w-5 flex-shrink-0">
                  {row.error ? (
                    <XCircle
                      role="img"
                      className="h-4 w-4 text-red-500"
                      aria-label={`Failed: ${row.error}`}
                    />
                  ) : row.url ? (
                    <CheckCircle2
                      role="img"
                      className="h-4 w-4 text-emerald-600"
                      aria-label="Moved"
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
