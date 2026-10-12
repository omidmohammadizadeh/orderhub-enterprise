"use client";

// Walk-ins: the barber's queue on the till.
//
// Add someone at the door (or they add themselves from the QR on the
// window), see each person's honest wait — worked out against the actual
// bookings so nobody is promised a chair that's spoken for — call them up,
// put them in the chair, take payment. A "Quick sale" covers the cut that
// never touched the queue at all.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Bell, CreditCard, ExternalLink, Monitor, Play, Plus, QrCode, RotateCcw, Scissors, UserMinus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/use-currency";
import {
  apiError,
  salonClient,
  shopTime,
  type QueueBoard,
  type QueueEntry,
  type SalonService,
  type SalonStaff,
  type WantedService,
} from "@/lib/api/salon.client";
import { SalonFrame, inputBase, inputCls, staffWord, useSalonLocation, useSalonServices, useSalonStaff } from "@/components/salon/salon-shared";
import { ServicePicker } from "@/components/salon/new-appointment";
import { AppointmentDrawer } from "@/components/salon/appointment-drawer";
import { CheckoutPanel } from "@/components/salon/checkout-panel";

export default function SalonQueuePage() {
  return (
    <SalonFrame title="Walk-ins" subtitle="Who's waiting, how long for, and who's next in the chair.">
      <Queue />
    </SalonFrame>
  );
}

function waitText(mins: number | null): string {
  if (mins === null) return "Can't fit in today";
  if (mins <= 2) return "Next up";
  if (mins < 60) return `~${Math.round(mins / 5) * 5 || 5} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round((mins % 60) / 5) * 5;
  return `~${h}h${m ? ` ${m}m` : ""}`;
}

function Queue() {
  const qc = useQueryClient();
  const { locationId, settings } = useSalonLocation();
  const trade = settings.data?.settings.trade ?? "BARBER";
  const services = useSalonServices(locationId);
  const staffQ = useSalonStaff(locationId);
  const staff = staffQ.data ?? [];
  const [adding, setAdding] = useState(false);
  const [quick, setQuick] = useState(false);
  const [starting, setStarting] = useState<QueueEntry | null>(null);
  const [openAppt, setOpenAppt] = useState<string | null>(null);
  const [showLinks, setShowLinks] = useState(false);

  const board = useQuery({
    queryKey: ["salon", "queue", locationId],
    queryFn: () => salonClient.queue(locationId!),
    enabled: !!locationId,
    // Waits move as the clock does, even when nothing else happens.
    refetchInterval: 60_000,
  });
  const set = (b: QueueBoard) => qc.setQueryData(["salon", "queue", locationId], b);

  const act = useMutation({
    mutationFn: async (v: { kind: "call" | "requeue" | "left" | "done"; id: string; staffId?: string }) => {
      if (v.kind === "call") return salonClient.queueCall(v.id, v.staffId);
      if (v.kind === "requeue") return salonClient.queueRequeue(v.id);
      if (v.kind === "left") return salonClient.queueLeft(v.id);
      return salonClient.queueDone(v.id);
    },
    onSuccess: (b, v) => {
      set(b);
      const e = b.entries.find((x) => x.id === v.id);
      if (v.kind === "call") toast.success(`Called ${e?.customerName ?? "them"}${e?.staffName ? ` for ${e.staffName}` : ""}`);
    },
    onError: (e) => toast.error(apiError(e, "Couldn't update the queue")),
  });

  const entries = board.data?.entries ?? [];
  const waiting = entries.filter((e) => e.status === "WAITING");
  const called = entries.filter((e) => e.status === "CALLED");
  const inChair = entries.filter((e) => e.status === "IN_SERVICE");
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  if (settings.data && !settings.data.settings.queueEnabled) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-600">
        The walk-in queue is off for this shop. Switch it on in Settings.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <p className="text-3xl font-semibold tabular-nums text-zinc-900">
            {waiting.length} <span className="text-base font-medium text-zinc-500">waiting</span>
          </p>
          <p className="text-sm text-zinc-500">
            {board.data && !board.data.openNow && board.data.opensAt
              ? `Not open yet — first chair at ${shopTime(board.data.opensAt, board.data.timezone)}`
              : `A new walk-in would wait ${waitText(board.data?.nextWaitMins ?? null).replace("~", "about ")}`}
            {board.data && ` · ${board.data.barbersOn.length} ${staffWord(trade, board.data.barbersOn.length !== 1).toLowerCase()} on`}
          </p>
        </div>
        <Button variant="outline" onClick={() => setShowLinks((s) => !s)}>
          <QrCode className="h-4 w-4" aria-hidden /> Screen & QR
        </Button>
        <Button variant="outline" onClick={() => setQuick(true)}>
          <Scissors className="h-4 w-4" aria-hidden /> Quick sale
        </Button>
        <Button onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" aria-hidden /> Add walk-in
        </Button>
      </div>

      {showLinks && locationId && (
        <section className="grid gap-3 rounded-2xl border border-zinc-200 bg-white p-4 sm:grid-cols-2">
          <LinkCard
            icon={<Monitor className="h-4 w-4" aria-hidden />}
            title="Queue screen for the TV"
            hint="Open on a smart TV or spare tablet by the door. Shows the queue and a QR code to join."
            url={`${origin}/salon/${locationId}/board`}
          />
          <LinkCard
            icon={<QrCode className="h-4 w-4" aria-hidden />}
            title="Join from your phone"
            hint="Print this as a QR for the window — customers join and get a live place in line."
            url={`${origin}/salon/${locationId}/queue`}
          />
        </section>
      )}

      {board.isError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{apiError(board.error, "Couldn't load the queue")}</p>}

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <section>
          <h2 className="mb-2 text-sm font-semibold text-zinc-800">Waiting</h2>
          {waiting.length === 0 && called.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
              Nobody waiting. Tap Add walk-in when someone comes through the door.
            </p>
          ) : (
            <ol className="space-y-2">
              {[...called, ...waiting].map((e) => (
                <li key={e.id} className={`rounded-2xl border bg-white p-4 shadow-card-sm ${e.status === "CALLED" ? "border-orange-300 ring-2 ring-orange-100" : "border-zinc-200"}`}>
                  <div className="flex flex-wrap items-start gap-3">
                    <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-bold ${e.status === "CALLED" ? "bg-orange-500 text-white" : "bg-zinc-900 text-white"}`}>
                      {e.status === "CALLED" ? <Bell className="h-4 w-4" aria-label="Called" /> : e.position}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base font-semibold text-zinc-900">{e.customerName}</p>
                      <p className="truncate text-sm text-zinc-600">{e.serviceSummary ?? "Not chosen yet"}</p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {e.status === "CALLED"
                          ? `Called ${e.calledAt ? new Date(e.calledAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : ""}${e.staffName ? ` for ${e.staffName}` : ""}`
                          : board.data && !board.data.openNow && board.data.opensAt && e.position === 1
                            ? `First in when we open${e.likelyStaffName ? ` · likely ${e.likelyStaffName}` : ""}`
                            : `${waitText(e.waitMins)}${e.likelyStaffName ? ` · likely ${e.likelyStaffName}` : ""}`}
                        {e.preferredStaffName && ` · waiting for ${e.preferredStaffName}`}
                        {e.source === "ONLINE" && " · joined online"}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {e.status === "WAITING" ? (
                        <Button size="sm" variant="outline" onClick={() => act.mutate({ kind: "call", id: e.id })}>
                          <Bell className="h-3.5 w-3.5" aria-hidden /> Call
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => act.mutate({ kind: "requeue", id: e.id })}>
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Back of queue
                        </Button>
                      )}
                      <Button size="sm" onClick={() => setStarting(e)}>
                        <Play className="h-3.5 w-3.5" aria-hidden /> In the chair
                      </Button>
                      <Button size="sm" variant="ghost" aria-label={`${e.customerName} left`} onClick={() => act.mutate({ kind: "left", id: e.id })}>
                        <UserMinus className="h-3.5 w-3.5" aria-hidden /> Left
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-zinc-800">In the chair</h2>
          {inChair.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-zinc-300 bg-white p-6 text-center text-sm text-zinc-500">Nobody from the queue right now.</p>
          ) : (
            <ul className="space-y-2">
              {inChair.map((e) => (
                <li key={e.id} className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/50 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-zinc-900">{e.customerName}</p>
                    <p className="truncate text-xs text-zinc-600">
                      {e.serviceSummary} · {e.staffName}
                    </p>
                  </div>
                  {e.appointmentId && (
                    <Button size="sm" onClick={() => setOpenAppt(e.appointmentId)}>
                      <CreditCard className="h-3.5 w-3.5" aria-hidden /> Pay
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <h2 className="mb-2 mt-5 text-sm font-semibold text-zinc-800">On today</h2>
          <ul className="flex flex-wrap gap-2">
            {(board.data?.barbersOn ?? []).map((b) => (
              <li key={b.id} className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-sm">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: b.colour }} aria-hidden />
                {b.name}
              </li>
            ))}
            {board.data && board.data.barbersOn.length === 0 && <li className="text-sm text-zinc-500">Nobody taking walk-ins right now.</li>}
          </ul>
        </section>
      </div>

      {adding && locationId && (
        <AddWalkIn
          locationId={locationId}
          services={services.data ?? []}
          staff={staff.filter((s) => s.acceptsWalkIns)}
          onClose={() => setAdding(false)}
          onAdded={(b) => {
            set(b);
            setAdding(false);
          }}
        />
      )}
      {starting && (
        <StartWalkIn
          entry={starting}
          services={services.data ?? []}
          staff={staff}
          onClose={() => setStarting(null)}
          onStarted={(apptId, b) => {
            set(b);
            setStarting(null);
            qc.invalidateQueries({ queryKey: ["salon", "appointments"] });
            toast.success("In the chair — take payment when they're done");
            void apptId;
          }}
        />
      )}
      {quick && locationId && (
        <QuickSale
          locationId={locationId}
          services={services.data ?? []}
          staff={staff}
          onClose={() => setQuick(false)}
        />
      )}
      {openAppt && locationId && (
        <AppointmentDrawer
          appointmentId={openAppt}
          locationId={locationId}
          tz={settings.data?.timezone ?? "Europe/London"}
          staff={staff}
          onClose={() => setOpenAppt(null)}
          onChanged={() => qc.invalidateQueries({ queryKey: ["salon", "queue", locationId] })}
        />
      )}
    </div>
  );
}

function LinkCard({ icon, title, hint, url }: { icon: React.ReactNode; title: string; hint: string; url: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 p-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
        {icon} {title}
      </p>
      <p className="mt-1 text-xs text-zinc-500">{hint}</p>
      <div className="mt-2 flex gap-2">
        <input readOnly value={url} aria-label={title} className={`${inputBase} h-9 min-w-0 flex-1 text-xs`} onFocus={(e) => e.currentTarget.select()} />
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1 rounded-lg border border-zinc-200 px-3 text-xs font-medium hover:bg-zinc-50">
          Open <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
      </div>
    </div>
  );
}

function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 cursor-default bg-zinc-950/50" />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-lg font-semibold text-zinc-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-full text-zinc-400 hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-4">{footer}</div>
      </div>
    </div>
  );
}

function AddWalkIn({
  locationId,
  services,
  staff,
  onClose,
  onAdded,
}: {
  locationId: string;
  services: SalonService[];
  staff: SalonStaff[];
  onClose: () => void;
  onAdded: (b: QueueBoard) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [wanted, setWanted] = useState<WantedService[]>([]);
  const [pref, setPref] = useState("");
  const add = useMutation({
    mutationFn: () =>
      salonClient.queueJoin({
        locationId,
        customerName: name.trim(),
        customerPhone: phone.trim() || undefined,
        serviceIds: wanted.map((w) => w.serviceId),
        preferredStaffId: pref || undefined,
      }),
    onSuccess: (b) => {
      toast.success(`${name.trim()} added to the queue`);
      onAdded(b);
    },
    onError: (e) => toast.error(apiError(e, "Couldn't add them")),
  });
  return (
    <Sheet
      title="Add walk-in"
      onClose={onClose}
      footer={
        <Button disabled={!name.trim()} loading={add.isPending} onClick={() => add.mutate()}>
          Add to queue
        </Button>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label>
          <span className="text-sm font-medium text-zinc-800">Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} mt-1`} />
        </label>
        <label>
          <span className="text-sm font-medium text-zinc-800">Phone (to text when it&rsquo;s their turn)</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" className={`${inputCls} mt-1`} />
        </label>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-zinc-800">Having (optional — helps the wait estimate)</p>
        <ServicePicker services={services} value={wanted} onChange={(v) => setWanted(v.map((x) => ({ serviceId: x.serviceId })))} />
      </div>
      <label className="block">
        <span className="text-sm font-medium text-zinc-800">Waiting for</span>
        <select value={pref} onChange={(e) => setPref(e.target.value)} className={`${inputCls} mt-1`}>
          <option value="">Whoever is free first</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
    </Sheet>
  );
}

function StartWalkIn({
  entry,
  services,
  staff,
  onClose,
  onStarted,
}: {
  entry: QueueEntry;
  services: SalonService[];
  staff: SalonStaff[];
  onClose: () => void;
  onStarted: (appointmentId: string, b: QueueBoard) => void;
}) {
  const [staffId, setStaffId] = useState(entry.staffId ?? entry.preferredStaffId ?? entry.likelyStaffId ?? staff[0]?.id ?? "");
  const [wanted, setWanted] = useState<WantedService[]>(entry.serviceIds.map((serviceId) => ({ serviceId })));
  const start = useMutation({
    mutationFn: () => salonClient.queueStart(entry.id, { staffId, services: wanted }),
    onSuccess: (r) => onStarted(r.appointmentId, r.board),
    onError: (e) => toast.error(apiError(e, "Couldn't start them")),
  });
  const person = useMemo(() => staff.find((s) => s.id === staffId) ?? null, [staff, staffId]);
  return (
    <Sheet
      title={`${entry.customerName} into the chair`}
      onClose={onClose}
      footer={
        <Button disabled={!staffId || wanted.length === 0} loading={start.isPending} onClick={() => start.mutate()}>
          Start
        </Button>
      }
    >
      <div className="flex flex-wrap gap-2">
        {staff.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setStaffId(s.id)}
            aria-pressed={staffId === s.id}
            className={`inline-flex h-10 items-center gap-2 rounded-full border px-4 text-sm font-medium ${staffId === s.id ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200"}`}
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.colour }} aria-hidden />
            {s.name}
          </button>
        ))}
      </div>
      <ServicePicker services={services} value={wanted} onChange={setWanted} staff={person} />
    </Sheet>
  );
}

function QuickSale({
  locationId,
  services,
  staff,
  onClose,
}: {
  locationId: string;
  services: SalonService[];
  staff: SalonStaff[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { money } = useCurrency();
  const [staffId, setStaffId] = useState(staff[0]?.id ?? "");
  const [wanted, setWanted] = useState<WantedService[]>([]);
  const [name, setName] = useState("");
  const [apptId, setApptId] = useState<string | null>(null);
  const person = staff.find((s) => s.id === staffId) ?? null;
  const total = wanted.reduce((t, w) => {
    const s = services.find((x) => x.id === w.serviceId);
    if (!s) return t;
    const base = person?.priceOverrides?.[s.id] ?? s.price;
    return t + base + s.addons.filter((a) => w.addonIds?.includes(a.id)).reduce((x, a) => x + a.price, 0);
  }, 0);
  // Make the visit first (it holds the barber's time and the takings), then
  // the normal checkout screen takes the money.
  const create = useMutation({
    mutationFn: () =>
      salonClient.book({
        locationId,
        staffId,
        startsAt: new Date().toISOString(),
        services: wanted,
        customerName: name.trim() || "Walk-in",
        source: "WALK_IN",
        force: true,
        silent: true,
      }),
    onSuccess: async (a) => {
      await salonClient.setStatus(a.id, { status: "IN_SERVICE" }).catch(() => undefined);
      setApptId(a.id);
    },
    onError: (e) => toast.error(apiError(e, "Couldn't start the sale")),
  });
  const detail = useQuery({
    queryKey: ["salon", "appointment", apptId],
    queryFn: () => salonClient.appointment(apptId!),
    enabled: !!apptId,
  });
  if (apptId && detail.data) {
    return (
      <CheckoutPanel
        appointment={detail.data}
        locationId={locationId}
        onClose={onClose}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["salon"] });
          onClose();
        }}
      />
    );
  }
  return (
    <Sheet
      title="Quick sale"
      onClose={onClose}
      footer={
        <Button disabled={!staffId || wanted.length === 0} loading={create.isPending || (!!apptId && detail.isLoading)} onClick={() => create.mutate()}>
          Checkout {total > 0 ? money(total) : ""}
        </Button>
      }
    >
      <p className="text-sm text-zinc-500">A cut that didn&rsquo;t come through the diary or the queue. It still counts toward the barber&rsquo;s takings.</p>
      <div className="flex flex-wrap gap-2">
        {staff.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setStaffId(s.id)}
            aria-pressed={staffId === s.id}
            className={`inline-flex h-10 items-center gap-2 rounded-full border px-4 text-sm font-medium ${staffId === s.id ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200"}`}
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.colour }} aria-hidden />
            {s.name}
          </button>
        ))}
      </div>
      <ServicePicker services={services} value={wanted} onChange={setWanted} staff={person} />
      <label className="block">
        <span className="text-sm font-medium text-zinc-800">Name (optional)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Walk-in" className={`${inputCls} mt-1`} />
      </label>
    </Sheet>
  );
}
