"use client";

// The shop's FSA food hygiene rating, as the storefront shows it. Self-
// contained like the WhatsApp panel: loads and saves its own state through
// /v1/locations/:id/hygiene. Once linked, the API re-checks the FSA nightly,
// so a re-inspection reaches the storefront without anyone coming back here.

import { useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { locationsClient, type LocationHygiene } from "@/lib/api/locations.client";

function formatDate(value: string | null | undefined, withTime = false): string | null {
  if (!value) return null;
  const d = new Date(withTime ? value : `${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : { timeZone: "UTC" }),
  });
}

/** "4" → "4 / 5"; "AwaitingInspection" → "Awaiting inspection". */
function ratingText(rating: string): string {
  if (/^[0-5]$/.test(rating)) return `${rating} / 5`;
  return rating.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function HygieneRatingSection({ locationId }: { locationId: string }) {
  const [hygiene, setHygiene] = useState<LocationHygiene | null>(null);
  const [link, setLink] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "refresh" | "show" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    locationsClient
      .getHygiene(locationId)
      .then((h) => live && setHygiene(h))
      .catch(() => live && setHygiene(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [locationId]);

  const run = async (
    kind: "save" | "refresh" | "show",
    call: () => Promise<LocationHygiene | null>,
    ok: (h: LocationHygiene | null) => string,
  ) => {
    setBusy(kind);
    setMsg(null);
    try {
      const h = await call();
      setHygiene(h);
      setMsg({ kind: "ok", text: ok(h) });
    } catch (err: any) {
      setMsg({ kind: "err", text: err?.response?.data?.message ?? err?.message ?? "Something went wrong." });
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run(
      "save",
      () => locationsClient.setHygiene(locationId, link.trim() ? { url: link.trim() } : {}),
      (h) => {
        setLink("");
        return h ? `Linked — rating ${ratingText(h.rating)}.` : "Saved.";
      },
    );

  const refresh = () =>
    run("refresh", () => locationsClient.refreshHygiene(locationId), (h) =>
      h ? `Up to date — rating ${ratingText(h.rating)}.` : "Up to date.",
    );

  const toggleShow = (show: boolean) =>
    run("show", () => locationsClient.setHygiene(locationId, { show }), () =>
      show ? "Shown on the storefront." : "Hidden from the storefront.",
    );

  const rated = formatDate(hygiene?.ratingDate);
  const checked = formatDate(hygiene?.checkedAt, true);

  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Food hygiene rating
        </h3>
        {hygiene && (
          <span
            className={
              hygiene.show
                ? "inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700"
                : "inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-600"
            }
          >
            ● {hygiene.show ? "On storefront" : "Hidden"}
          </span>
        )}
      </div>
      <p className="text-[11px] text-zinc-500">
        Shows this shop&apos;s Food Standards Agency rating on the storefront. Checked again every
        night, so a new inspection appears by itself.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-zinc-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          {hygiene ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-zinc-900 tabular-nums">
                  {ratingText(hygiene.rating)}
                </div>
                <div className="text-[11px] text-zinc-500">
                  {rated ? `Rated ${rated}` : "No inspection date"}
                  {checked ? ` · checked ${checked}` : ""}
                </div>
              </div>
              <a
                href={`https://ratings.food.gov.uk/business/${encodeURIComponent(hygiene.fsaId)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-zinc-600 hover:text-zinc-900"
              >
                FSA record <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            </div>
          ) : (
            <p className="text-[11px] text-zinc-500">Not linked yet.</p>
          )}

          <div className="space-y-1">
            <label htmlFor={`fsa-link-${locationId}`} className="text-[11px] font-medium text-zinc-600">
              ratings.food.gov.uk link (optional)
            </label>
            <input
              id={`fsa-link-${locationId}`}
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://ratings.food.gov.uk/business/247023/…"
              className="w-full rounded-md border border-zinc-200 px-2 py-1.5 text-sm focus:border-zinc-900 focus:outline-none"
            />
            <span className="text-[10px] text-zinc-400">
              Leave empty to find the shop by its name and postcode.
            </span>
          </div>

          {hygiene && (
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={hygiene.show}
                disabled={busy !== null}
                onChange={(e) => toggleShow(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-300"
              />
              Show on the storefront
            </label>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            {hygiene && (
              <button
                type="button"
                onClick={refresh}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
              >
                {busy === "refresh" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Refresh now
              </button>
            )}
            <button
              type="button"
              onClick={save}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {busy === "save" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {link.trim() ? "Save" : "Find automatically"}
            </button>
          </div>

          {msg && (
            <p className={msg.kind === "ok" ? "text-[11px] text-emerald-700" : "text-[11px] text-red-600"}>
              {msg.text}
            </p>
          )}
        </>
      )}
    </div>
  );
}
