"use client";

// Marketing → Welcome screen.
//
// The full-screen picture a phone customer sees once when they open this
// shop's ordering link — with an "Order now" button that goes to the menu.
// Per LOCATION, and schedulable: keep an everyday picture with no dates, and
// add occasions (Christmas, Ramadan, a new deal) with start and end dates.
// The occasion takes over for its dates and the everyday one comes back on
// its own afterwards.
//
// Stored on Location.settings.storefrontSplash; the API picks today's one in
// the shop's timezone (ordering/storefront-splash.ts).

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  CalendarRange,
  ExternalLink,
  Pencil,
  Plus,
  Smartphone,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImageUploader } from "@/components/products/image-uploader";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { useAuthStore } from "@/stores/auth.store";
import { locationsClient } from "@/lib/api/locations.client";
import { menusClient } from "@/lib/api/menus.client";
import { queryKeys } from "@/lib/api/query-keys";

interface Splash {
  id: string;
  name: string;
  imageUrl: string;
  headline?: string | null;
  subline?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  enabled: boolean;
}

const OCCASIONS = [
  "Christmas",
  "Ramadan iftar",
  "Eid",
  "Valentine's Day",
  "Mother's Day",
  "Halloween",
  "Summer deals",
  "Match day",
];

function todayStr() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function statusOf(s: Splash, all: Splash[]): { label: string; tone: string } {
  const today = todayStr();
  if (!s.enabled) return { label: "Off", tone: "bg-zinc-100 text-zinc-500" };
  if (s.endDate && today > s.endDate) return { label: "Ended", tone: "bg-zinc-100 text-zinc-500" };
  if (s.startDate && today < s.startDate) return { label: "Scheduled", tone: "bg-sky-100 text-sky-800" };
  // Live — but is it the one winning today? (Same rule as the API.)
  const live = all
    .filter((x) => x.enabled && !(x.startDate && today < x.startDate) && !(x.endDate && today > x.endDate))
    .sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? ""));
  return live[0]?.id === s.id
    ? { label: "Showing now", tone: "bg-emerald-100 text-emerald-800" }
    : { label: "Waiting (another is showing)", tone: "bg-amber-100 text-amber-800" };
}

function fmtDate(d?: string | null) {
  if (!d) return null;
  return new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function WelcomeScreenPage() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const role = useAuthStore((s) => s.user?.role);
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Splash | null>(null);

  const locationQuery = useQuery({
    queryKey: queryKeys.locationDetail(locationId ?? ""),
    queryFn: () => locationsClient.get(locationId!),
    enabled: !!locationId,
  });
  const urlQuery = useQuery({
    queryKey: ["location-online-url", locationId],
    queryFn: () => locationsClient.onlineUrl(locationId!),
    enabled: !!locationId,
    retry: false,
  });

  const splashes: Splash[] = useMemo(() => {
    const list = ((locationQuery.data as any)?.settings?.storefrontSplash?.splashes ?? []) as Splash[];
    return Array.isArray(list) ? list : [];
  }, [locationQuery.data]);

  const save = useMutation({
    mutationFn: (next: Splash[]) =>
      locationsClient.update(locationId!, {
        settings: { storefrontSplash: { splashes: next } },
      } as any),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.locationDetail(locationId ?? "") });
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? "Couldn't save"),
  });

  const upsert = async (s: Splash) => {
    const exists = splashes.some((x) => x.id === s.id);
    const next = exists ? splashes.map((x) => (x.id === s.id ? s : x)) : [...splashes, s];
    await save.mutateAsync(next);
    toast.success("Welcome screen saved");
    setEditing(null);
  };

  const previewUrl = urlQuery.data?.url
    ? `${urlQuery.data.url}${urlQuery.data.url.includes("?") ? "&" : "?"}splash=preview`
    : null;

  if (!locationId) {
    return <p className="p-6 text-sm text-zinc-500">Select a location first.</p>;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-zinc-900">
            <Smartphone className="h-5 w-5 text-orange-500" aria-hidden /> Welcome screen
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            A full-screen picture customers see once a day when they open your ordering link on a phone, with an{" "}
            <b>Order now</b> button to the menu. Keep an everyday one, and schedule occasions — they take over for their
            dates and switch back on their own.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {previewUrl && splashes.length > 0 && (
            <a
              href={previewUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
            >
              <ExternalLink className="h-4 w-4" aria-hidden /> Preview today's
            </a>
          )}
          <Button
            className="min-h-[44px]"
            onClick={() =>
              setEditing({
                id: `sp_${Date.now().toString(36)}`,
                name: "",
                imageUrl: "",
                headline: "",
                subline: "",
                startDate: null,
                endDate: null,
                enabled: true,
              })
            }
          >
            <Plus className="h-4 w-4" /> New welcome screen
          </Button>
        </div>
      </div>

      <SizeGuide />

      {locationQuery.isLoading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : splashes.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-200 bg-white p-10 text-center">
          <Smartphone className="mx-auto h-8 w-8 text-zinc-300" aria-hidden />
          <p className="mx-auto mt-3 max-w-md text-sm text-zinc-600">
            No welcome screen yet. Add one with <b>New welcome screen</b> — upload a 1080 × 1920 picture
            {role === "PLATFORM_ADMIN" ? " or generate one with AI" : ""}.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {splashes.map((s) => {
            const st = statusOf(s, splashes);
            return (
              <div key={s.id} className="flex gap-4 rounded-2xl border border-zinc-200 bg-white p-3 shadow-card-sm">
                <div className="relative aspect-[9/16] w-24 shrink-0 overflow-hidden rounded-xl bg-zinc-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.imageUrl} alt="" className="h-full w-full object-cover" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="truncate text-sm font-semibold text-zinc-900">{s.name || "Untitled"}</h3>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${st.tone}`}>
                      {st.label}
                    </span>
                  </div>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
                    <CalendarRange className="h-3.5 w-3.5" aria-hidden />
                    {s.startDate || s.endDate
                      ? `${fmtDate(s.startDate) ?? "Now"} – ${fmtDate(s.endDate) ?? "no end"}`
                      : "Every day (no dates)"}
                  </p>
                  {s.headline && <p className="mt-1 line-clamp-2 text-xs text-zinc-700">“{s.headline}”</p>}
                  <div className="mt-auto flex items-center gap-1 pt-2">
                    <label className="mr-auto inline-flex min-h-[36px] items-center gap-2 text-xs text-zinc-600">
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        onChange={(e) =>
                          save.mutate(splashes.map((x) => (x.id === s.id ? { ...x, enabled: e.target.checked } : x)))
                        }
                        className="h-4 w-4 accent-orange-500"
                      />
                      On
                    </label>
                    <button
                      type="button"
                      onClick={() => setEditing(s)}
                      aria-label={`Edit ${s.name}`}
                      className="grid h-9 w-9 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(`Delete "${s.name || "this welcome screen"}"?`))
                          save.mutate(splashes.filter((x) => x.id !== s.id));
                      }}
                      aria-label={`Delete ${s.name}`}
                      className="grid h-9 w-9 place-items-center rounded-md text-zinc-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <SplashEditor
          initial={editing}
          locationId={locationId}
          canGenerate={role === "PLATFORM_ADMIN"}
          saving={save.isPending}
          onClose={() => setEditing(null)}
          onSave={upsert}
        />
      )}
    </div>
  );
}

function SizeGuide() {
  return (
    <details className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-600 open:pb-4">
      <summary className="cursor-pointer font-medium text-zinc-800">Picture size and layout guide</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          Design at <b>1080 × 1920 px</b> (portrait 9:16), JPG or WebP, under about 400 KB.
        </li>
        <li>Keep the food and anything important in the middle 880 px of the width — tall phones trim the sides.</li>
        <li>Keep the top 150 px and the bottom 350 px calm: the close button and the Order now button sit there.</li>
        <li>
          Prefer the <b>Headline</b> and <b>Subline</b> boxes over text inside the picture — they stay sharp on every
          phone and never get cropped.
        </li>
      </ul>
    </details>
  );
}

function SplashEditor({
  initial,
  locationId,
  canGenerate,
  saving,
  onClose,
  onSave,
}: {
  initial: Splash;
  locationId: string;
  canGenerate: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (s: Splash) => Promise<void>;
}) {
  const [s, setS] = useState<Splash>(initial);
  const [brief, setBrief] = useState("");
  const [generating, setGenerating] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [guides, setGuides] = useState(true);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const set = (patch: Partial<Splash>) => setS((x) => ({ ...x, ...patch }));

  useEffect(() => () => {
    if (poll.current) clearInterval(poll.current);
  }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const generate = async () => {
    setGenerating(true);
    setFeedback("Generating — about a minute.");
    try {
      const started = await menusClient.generateStorefrontSplash({
        locationId,
        brief: brief.trim() || s.name.trim() || undefined,
      });
      if (!started.jobId) {
        setFeedback(started.error ?? "Could not start");
        setGenerating(false);
        return;
      }
      poll.current = setInterval(async () => {
        try {
          const r = await menusClient.getMenuBannerJob(started.jobId!);
          if (r.status === "running") return;
          if (poll.current) clearInterval(poll.current);
          setGenerating(false);
          if (r.status === "done" && r.url) {
            set({ imageUrl: r.url });
            setFeedback("Generated — press Save to keep it.");
          } else if (r.status === "unknown") {
            setFeedback("The API restarted and the job was lost — try again.");
          } else {
            setFeedback(r.error ?? "Generation failed");
          }
        } catch {
          /* next tick retries */
        }
      }, 3000);
    } catch (e: any) {
      setGenerating(false);
      setFeedback(e?.response?.data?.message ?? e.message ?? "Could not start");
    }
  };

  const datesBad = !!(s.startDate && s.endDate && s.endDate < s.startDate);
  const input =
    "w-full min-h-[44px] rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-zinc-950/50 p-3 sm:p-6" role="dialog" aria-modal="true">
      <div className="flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">
            {initial.imageUrl ? "Edit welcome screen" : "New welcome screen"}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid flex-1 gap-6 overflow-y-auto p-5 md:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            <Field label="Name (staff only)">
              <input value={s.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Christmas 2026" className={input} />
            </Field>

            <div className="flex flex-wrap gap-1.5">
              {OCCASIONS.map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => {
                    if (!s.name) set({ name: o });
                    setBrief(o);
                  }}
                  className="min-h-[32px] rounded-full border border-zinc-200 px-3 text-xs text-zinc-600 hover:border-orange-300 hover:text-orange-700"
                >
                  {o}
                </button>
              ))}
            </div>

            <Field label="Picture (1080 × 1920)">
              <div className="max-w-[280px]">
                <ImageUploader value={s.imageUrl || null} onChange={(v) => set({ imageUrl: v ?? "" })} targetWidth={1080} targetHeight={1920} />
              </div>
            </Field>

            {canGenerate && (
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  <Sparkles className="h-3.5 w-3.5" aria-hidden /> Generate with AI
                </div>
                <p className="mt-1 text-xs text-zinc-500">Built from this shop's real menu. Say the occasion or the mood.</p>
                <div className="mt-2 flex gap-2">
                  <input
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                    placeholder="e.g. Christmas, cosy, red and gold, festive pizza"
                    className={input}
                    disabled={generating}
                  />
                  <Button onClick={() => void generate()} loading={generating} className="min-h-[44px] shrink-0">
                    Generate
                  </Button>
                </div>
                {feedback && <p className="mt-2 text-xs text-zinc-600">{feedback}</p>}
              </div>
            )}

            <Field label="Headline (optional)">
              <input
                value={s.headline ?? ""}
                maxLength={60}
                onChange={(e) => set({ headline: e.target.value })}
                placeholder="e.g. Christmas boxes are here"
                className={input}
              />
            </Field>
            <Field label="Subline (optional)">
              <input
                value={s.subline ?? ""}
                maxLength={90}
                onChange={(e) => set({ subline: e.target.value })}
                placeholder="e.g. Feed the family from £24.99"
                className={input}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Starts (optional)">
                <input type="date" value={s.startDate ?? ""} onChange={(e) => set({ startDate: e.target.value || null })} className={input} />
              </Field>
              <Field label="Ends (optional)">
                <input type="date" value={s.endDate ?? ""} min={s.startDate ?? undefined} onChange={(e) => set({ endDate: e.target.value || null })} className={input} />
              </Field>
            </div>
            <p className="-mt-2 text-xs text-zinc-500">
              {datesBad
                ? "The end date is before the start date."
                : "No dates = every day. An occasion with dates takes over from the everyday one while it runs."}
            </p>

            <label className="flex min-h-[40px] items-center gap-2 text-sm text-zinc-700">
              <input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="h-4 w-4 accent-orange-500" />
              Switched on
            </label>
          </div>

          {/* Phone preview */}
          <div className="md:sticky md:top-0">
            <div className="mb-2 flex items-center justify-between text-xs text-zinc-500">
              <span>Phone preview</span>
              <label className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} className="h-3.5 w-3.5 accent-orange-500" />
                Safe areas
              </label>
            </div>
            <PhonePreview splash={s} guides={guides} />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3">
          <Button variant="outline" onClick={onClose} className="min-h-[44px]">
            Cancel
          </Button>
          <Button
            onClick={() => void onSave({ ...s, name: s.name.trim() || "Welcome screen" })}
            loading={saving}
            disabled={!s.imageUrl || datesBad || generating}
            className="min-h-[44px]"
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A 9:19.5 phone (iPhone-shaped) showing exactly what the storefront draws. */
function PhonePreview({ splash, guides }: { splash: Splash; guides: boolean }) {
  return (
    <div className="mx-auto w-[240px] rounded-[2.2rem] border-[6px] border-zinc-900 bg-zinc-900 shadow-xl">
      <div className="relative aspect-[9/19.5] overflow-hidden rounded-[1.8rem] bg-zinc-800">
        {splash.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={splash.imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-xs text-zinc-500">No picture yet</div>
        )}
        <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/55 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-[45%] bg-gradient-to-t from-black/85 via-black/45 to-transparent" />
        <div className="absolute right-2.5 top-7 grid h-6 w-6 place-items-center rounded-full bg-black/45 text-white">
          <X className="h-3 w-3" />
        </div>
        {guides && (
          <>
            {/* Sides trimmed on tall phones vs the 9:16 canvas: none here,
                but the 880/1080 safe width is what survives 9:21 phones. */}
            <div className="pointer-events-none absolute inset-y-0 left-[9.3%] right-[9.3%] border-x border-dashed border-sky-300/80" />
            <div className="pointer-events-none absolute inset-x-0 top-0 h-[8%] bg-sky-400/15" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[18%] bg-sky-400/15" />
          </>
        )}
        <div className="absolute inset-x-0 bottom-0 px-4 pb-5 text-center text-white">
          {splash.headline && <div className="text-[15px] font-bold leading-tight [text-shadow:0_2px_8px_rgba(0,0,0,.5)]">{splash.headline}</div>}
          {splash.subline && <div className="mt-1 text-[10px] text-white/85">{splash.subline}</div>}
          <div className="mt-3 rounded-full bg-orange-500 py-2.5 text-xs font-semibold">Order now</div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-600">{label}</span>
      {children}
    </label>
  );
}
