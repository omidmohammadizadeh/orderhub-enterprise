"use client";

// How the salon runs: online booking, the rules guests book under,
// reminders, and the walk-in queue — plus the links to share.

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiError, salonClient, type SalonSettings, type SalonTrade } from "@/lib/api/salon.client";
import { SalonFrame, inputBase, inputCls, useCanManage, useSalonLocation } from "@/components/salon/salon-shared";

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
