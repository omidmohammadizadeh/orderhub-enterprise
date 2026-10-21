"use client";

// How the salon runs: online booking, the rules guests book under,
// reminders, and the walk-in queue — plus the links to share.

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Copy, ExternalLink, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiError, salonClient, type SalonSettings, type SalonTrade } from "@/lib/api/salon.client";
import { SalonFrame, inputBase, inputCls, useCanManage, useSalonLocation } from "@/components/salon/salon-shared";
import { AlertsTab } from "@/components/printers/alerts-tab";
import { ImageUploader } from "@/components/products/image-uploader";
import { SALON_ALERT_TRIGGERS } from "@/lib/api/printers.client";

export default function SalonSettingsPage() {
  return (
    <SalonFrame title="Salon settings" subtitle="Online booking, reminders, deposits and the walk-in queue.">
      <SettingsForm />
    </SalonFrame>
  );
}

function SettingsForm() {
  const qc = useQueryClient();
  const canManage = useCanManage();
  const { locationId, settings } = useSalonLocation();
  const [s, setS] = useState<SalonSettings | null>(null);
  useEffect(() => {
    if (settings.data) setS(settings.data.settings);
  }, [settings.data]);
  const save = useMutation({
    mutationFn: (patch: Partial<SalonSettings>) => salonClient.saveSettings(locationId!, patch),
    onSuccess: (r) => {
      qc.setQueryData(["salon", "settings", locationId], r);
      setS(r.settings);
      toast.success("Saved");
    },
    onError: (e) => toast.error(apiError(e, "Couldn't save")),
  });
  if (!s || !locationId) return null;
  const up = <K extends keyof SalonSettings>(k: K, v: SalonSettings[K]) => setS({ ...s, [k]: v });
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const bookUrl = `${origin}/salon/${locationId}`;
  const dirty = JSON.stringify(s) !== JSON.stringify(settings.data?.settings);

  return (
    <form
      className="max-w-3xl space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(s);
      }}
    >
      <Card title="Your booking page">
        <Toggle label="Take bookings online" hint="Guests pick a service, a person and a time, and get a confirmation email." checked={s.onlineBookingEnabled} onChange={(v) => up("onlineBookingEnabled", v)} />
        {s.onlineBookingEnabled && (
          <div className="flex flex-wrap gap-2">
            <input readOnly value={bookUrl} aria-label="Booking page link" onFocus={(e) => e.currentTarget.select()} className={`${inputBase} min-w-0 flex-1`} />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(bookUrl);
                toast.success("Link copied — put it in your Instagram bio and Google profile");
              }}
            >
              <Copy className="h-4 w-4" aria-hidden /> Copy
            </Button>
            <a href={bookUrl} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-1 rounded-lg border border-zinc-200 px-3 text-sm font-medium hover:bg-zinc-50">
              Open <ExternalLink className="h-4 w-4" aria-hidden />
            </a>
          </div>
        )}
        <Toggle label="Offer “anyone available” first" hint="Most guests don't mind who — it fills gaps and spreads the work." checked={s.offerAnyStaff} onChange={(v) => up("offerAnyStaff", v)} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Num label="Earliest online booking (minutes from now)" value={s.leadTimeMins} onChange={(v) => up("leadTimeMins", v)} />
          <Num label="How far ahead (days)" value={s.maxDaysAhead} onChange={(v) => up("maxDaysAhead", v)} />
          <label>
            <span className="text-xs text-zinc-600">Start times every</span>
            <select value={s.slotStepMins} onChange={(e) => up("slotStepMins", Number(e.target.value))} className={`${inputCls} mt-1`}>
              {[5, 10, 15, 20, 30, 60].map((n) => (
                <option key={n} value={n}>
                  {n} minutes
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block">
          <span className="text-xs text-zinc-600">Booking policy shown before confirming</span>
          <textarea value={s.bookingPolicy} onChange={(e) => up("bookingPolicy", e.target.value)} rows={3} placeholder="Please arrive 5 minutes early. Late arrivals may need to be rebooked." className={`${inputCls} mt-1 h-auto py-2`} />
        </label>
      </Card>

      <Card title="Your page">
        <p className="text-sm text-zinc-600">
          What guests see at your booking link before they book: your photos, a few words about you, your team, the price
          list, opening hours and a map. Opening hours and the address come from your location settings.
        </p>
        <label className="block">
          <span className="text-xs text-zinc-600">About you (one or two lines under your name)</span>
          <textarea
            value={s.about}
            onChange={(e) => up("about", e.target.value)}
            rows={2}
            maxLength={600}
            placeholder="Traditional barbers on the high street since 2015. Fades, beards and hot towel shaves."
            className={`${inputCls} mt-1 h-auto py-2`}
          />
        </label>
        <label className="block max-w-xs">
          <span className="text-xs text-zinc-600">Instagram</span>
          <div className="relative mt-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400">@</span>
            <input
              value={s.instagram}
              onChange={(e) => up("instagram", e.target.value.replace(/^@/, ""))}
              placeholder="zagrosbarbers"
              spellCheck={false}
              className={`${inputCls} pl-7`}
            />
          </div>
        </label>
        <div>
          <p className="text-xs text-zinc-600">Cover photo (the big picture at the top — your shop front or chair)</p>
          <div className="mt-1 max-w-md">
            <ImageUploader
              value={s.coverImageUrl}
              onChange={(url) => up("coverImageUrl", url && /^https:\/\//.test(url) ? url : null)}
              targetWidth={1600}
              targetHeight={900}
            />
          </div>
        </div>
        <div>
          <p className="text-xs text-zinc-600">Your work (up to 12 photos — fades, colours, nail sets)</p>
          <ul className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
            {s.gallery.map((src, i) => (
              <li key={src} className="group relative aspect-square overflow-hidden rounded-lg bg-zinc-100">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt="" className="h-full w-full object-cover" />
                <button
                  type="button"
                  aria-label="Remove photo"
                  onClick={() => up("gallery", s.gallery.filter((_, j) => j !== i))}
                  className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-black/60 text-xs font-bold text-white"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          {s.gallery.length < 12 && (
            <div className="mt-2 max-w-[220px]">
              <ImageUploader
                key={s.gallery.length}
                value={null}
                onChange={(url) => {
                  if (url && /^https:\/\//.test(url)) up("gallery", [...s.gallery, url]);
                }}
                targetWidth={1080}
                targetHeight={1080}
              />
            </div>
          )}
        </div>
        <p className="text-xs text-zinc-500">Add photos of each team member on the Team tab. Save settings to publish.</p>
      </Card>

      <Card title="Changes, cancellations and deposits">
        <Toggle label="Guests can move or cancel from their link" checked={s.allowGuestChanges} onChange={(v) => up("allowGuestChanges", v)} />
        <Num label="Free to change up to (hours before)" value={s.cancellationWindowHours} onChange={(v) => up("cancellationWindowHours", v)} />
        <p className="text-xs text-zinc-500">
          Cancel in time and a deposit is refunded automatically. Cancel late and you keep it. Deposits are set per service on the Services tab.
        </p>
        <Toggle label="Keep the deposit when someone doesn't turn up" checked={s.forfeitDepositOnNoShow} onChange={(v) => up("forfeitDepositOnNoShow", v)} />
      </Card>

      <Card title="Reminders">
        <Toggle label="Send a reminder before each appointment" hint="By email (free)." checked={s.reminderEnabled} onChange={(v) => up("reminderEnabled", v)} />
        {s.reminderEnabled && (
          <>
            <Num label="Hours before" value={s.reminderHoursBefore} onChange={(v) => up("reminderHoursBefore", v)} />
            <Toggle label="Text it as well" hint="Uses your SMS wallet — about 7p a text. Cuts no-shows the most." checked={s.reminderSms} onChange={(v) => up("reminderSms", v)} />
          </>
        )}
        <Num
          label="“Time for your next visit?” email after (days, 0 = off)"
          value={s.rebookAfterDays}
          onChange={(v) => up("rebookAfterDays", v)}
        />
        <Toggle
          label="Ask for a Google review after each visit"
          hint="Emailed a couple of hours after they've paid. Uses the Google review link on your location — add it under Locations if it's missing."
          checked={s.reviewRequestEnabled}
          onChange={(v) => up("reviewRequestEnabled", v)}
        />
      </Card>

      <Card title="Walk-in queue">
        <Toggle label="Run a walk-in queue" checked={s.queueEnabled} onChange={(v) => up("queueEnabled", v)} />
        {s.queueEnabled && (
          <>
            <Toggle label="Customers can join from their phone" hint="Scan the QR on the window, get a live place in line." checked={s.queueOnlineJoin} onChange={(v) => up("queueOnlineJoin", v)} />
            <Toggle label="Text them when they're called" hint="Uses your SMS wallet." checked={s.queueCallSms} onChange={(v) => up("queueCallSms", v)} />
          </>
        )}
      </Card>

      <Card title="Type of business">
        <label className="block">
          <span className="text-xs text-zinc-600">Changes the wording (barber, stylist, nail tech…)</span>
          <select value={s.trade} onChange={(e) => up("trade", e.target.value as SalonTrade)} className={`${inputCls} mt-1 max-w-xs`}>
            <option value="BARBER">Barbers</option>
            <option value="HAIR">Hair salon</option>
            <option value="NAILS">Nail salon</option>
            <option value="BEAUTY">Beauty</option>
          </select>
        </label>
      </Card>

      <Card title="Sounds">
        <p className="text-sm text-zinc-600">
          Every till signed in to this shop beeps when a guest books or cancels online, or joins the queue from their
          phone — the same chime as a new order (and the cancellation alarm for cancellations) until you change it here.
          Bookings made by staff stay quiet.
        </p>
        <AlertsTab locationId={locationId} only={SALON_ALERT_TRIGGERS} />
      </Card>

      <Card title="Moving from another system?">
        <p className="text-sm text-zinc-600">
          Bring your clients across from Fresha, Booksy, Treatwell or a spreadsheet: export your client list as CSV and add it here.
          They&rsquo;ll show up when you search for a client in the diary. Your price list imports on the Services tab.
        </p>
        <ClientImport locationId={locationId} />
      </Card>

      {canManage && (
        <div className="sticky bottom-4 flex justify-end">
          <Button type="submit" disabled={!dirty} loading={save.isPending} className="shadow-lg">
            Save settings
          </Button>
        </div>
      )}
    </form>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-5">
      <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
      {children}
    </section>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-orange-500" />
      <span>
        <span className="block text-sm font-medium text-zinc-900">{label}</span>
        {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
      </span>
    </label>
  );
}

function Num({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="text-xs text-zinc-600">{label}</span>
      <input
        inputMode="numeric"
        value={String(value)}
        onChange={(e) => onChange(Number(e.target.value.replace(/\D/g, "")) || 0)}
        className={`${inputCls} mt-1 max-w-[10rem]`}
      />
    </label>
  );
}

function ClientImport({ locationId }: { locationId: string }) {
  const [csv, setCsv] = useState("");
  const [name, setName] = useState<string | null>(null);
  const preview = useMutation({
    mutationFn: (text: string) => salonClient.importClients(locationId, text, true),
    onError: (e) => toast.error(apiError(e, "Couldn't read that file")),
  });
  const run = useMutation({
    mutationFn: () => salonClient.importClients(locationId, csv, false),
    onSuccess: (r) => {
      toast.success(`${r.imported} client${r.imported === 1 ? "" : "s"} added`);
      preview.reset();
      setCsv("");
      setName(null);
    },
    onError: (e) => toast.error(apiError(e, "Couldn't import")),
  });
  const p = preview.data;
  return (
    <div className="space-y-3">
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium hover:bg-zinc-50">
        <Upload className="h-4 w-4" aria-hidden />
        {name ?? "Choose client list (CSV)"}
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          className="sr-only"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const text = await f.text();
            setCsv(text);
            setName(f.name);
            preview.mutate(text);
          }}
        />
      </label>
      {preview.isPending && <p className="text-sm text-zinc-500">Reading…</p>}
      {p && (
        <div className="rounded-xl bg-zinc-50 p-3 text-sm text-zinc-700">
          <p>
            <strong>{p.new}</strong> new client{p.new === 1 ? "" : "s"}
            {p.alreadyKnown > 0 && `, ${p.alreadyKnown} you already have`}
            {p.skipped.length > 0 && `, ${p.skipped.length} row${p.skipped.length === 1 ? "" : "s"} skipped (no phone or email, or duplicates)`}.
          </p>
          {p.new > 0 && (
            <Button type="button" className="mt-2" loading={run.isPending} onClick={() => run.mutate()}>
              Add {p.new} client{p.new === 1 ? "" : "s"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
