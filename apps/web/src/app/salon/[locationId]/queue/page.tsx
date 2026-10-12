"use client";

// Join the walk-in queue from your phone — the QR on the shop window.
// The honest wait is shown before anyone types a thing.

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { UsersRound } from "lucide-react";
import { publicSalonClient } from "@/lib/api/salon.client";
import { PrimaryButton, SP, Shell, ShopHeader, display, fieldCls, staffNoun } from "@/components/salon-public/salon-public-ui";

function waitWords(m: number | null): string {
  if (m === null) return "Fully booked for walk-ins today";
  if (m <= 5) return "Straight in";
  if (m < 60) return `About ${Math.round(m / 5) * 5} min`;
  const r = Math.round((m % 60) / 5) * 5;
  return `About ${Math.floor(m / 60)}h${r ? ` ${r}m` : ""}`;
}

export default function JoinQueuePage() {
  const params = useParams<{ locationId: string }>();
  const locationId = params?.locationId ?? "";
  const router = useRouter();
  const shop = useQuery({ queryKey: ["salon-public", "shop", locationId], queryFn: () => publicSalonClient.shop(locationId), enabled: !!locationId, retry: false });
  const board = useQuery({ queryKey: ["salon-public", "board", locationId], queryFn: () => publicSalonClient.queueBoard(locationId), enabled: !!locationId, refetchInterval: 30_000, retry: false });
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [pref, setPref] = useState("");
  const [error, setError] = useState<string | null>(null);

  const join = useMutation({
    mutationFn: () =>
      publicSalonClient.queueJoin(locationId, {
        customerName: name.trim(),
        customerPhone: phone.trim(),
        serviceIds: serviceId ? [serviceId] : [],
        preferredStaffId: pref || undefined,
      }),
    onSuccess: (r) => router.push(`/salon/queue/${r.token}`),
    onError: (e: Error) => setError(e.message),
  });

  const s = shop.data;
  const b = board.data;
  if (shop.isLoading || board.isLoading) {
    return (
      <Shell>
        <div className="h-64 animate-pulse rounded-2xl bg-white" />
      </Shell>
    );
  }
  if (!s || !b) {
    return (
      <Shell>
        <p className={`text-3xl ${display}`}>We couldn&rsquo;t find this shop.</p>
      </Shell>
    );
  }
  const open = b.queueEnabled && b.onlineJoin;
  return (
    <Shell>
      <ShopHeader name={s.name} logoUrl={s.logoUrl} address={s.address} phone={s.phone} />
      <section className="mt-6 rounded-2xl px-5 py-6 text-white" style={{ background: SP.ink }}>
        <p className="text-[13px] opacity-75">{b.openNow ? "Walk-in wait right now" : "Walk-ins"}</p>
        <p className={`mt-1 text-[2.8rem] leading-none ${display}`}>
          {!b.openNow && b.opensAt
            ? `Opens ${new Date(b.opensAt).toLocaleTimeString("en-GB", { timeZone: b.timezone, hour: "2-digit", minute: "2-digit" })}`
            : waitWords(b.nextWaitMins)}
        </p>
        <p className="mt-2 flex items-center gap-1.5 text-[14px] opacity-80">
          <UsersRound className="h-4 w-4" aria-hidden /> {b.waiting.length} waiting · {b.barbersOn.length} {staffNoun(s.trade)}
          {b.barbersOn.length === 1 ? "" : "s"} on
        </p>
      </section>

      {!open ? (
        <p className="mt-5 rounded-2xl bg-white p-5 text-[15px]">
          {b.queueEnabled ? "Join the queue at the shop — just walk in." : "This shop isn't running a walk-in queue today."}
          {s.onlineBookingEnabled && (
            <>
              {" "}
              <a className="font-semibold underline" href={`/salon/${locationId}`}>
                Book a time instead
              </a>
              .
            </>
          )}
        </p>
      ) : (
        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            join.mutate();
          }}
        >
          <label className="block">
            <span className="text-[14px] font-semibold">Name</span>
            <input required autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} className={`${fieldCls} mt-1`} style={{ borderColor: SP.line }} />
          </label>
          <label className="block">
            <span className="text-[14px] font-semibold">Mobile</span>
            <input required autoComplete="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={`${fieldCls} mt-1`} style={{ borderColor: SP.line }} />
            <span className="mt-1 block text-[12px]" style={{ color: SP.steel }}>
              Keep your phone handy — we&rsquo;ll show your place live.
            </span>
          </label>
          {s.services.length > 0 && (
            <label className="block">
              <span className="text-[14px] font-semibold">Having</span>
              <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className={`${fieldCls} mt-1`} style={{ borderColor: SP.line }}>
                <option value="">Not sure yet</option>
                {s.services.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {s.staff.length > 1 && (
            <label className="block">
              <span className="text-[14px] font-semibold">Waiting for</span>
              <select value={pref} onChange={(e) => setPref(e.target.value)} className={`${fieldCls} mt-1`} style={{ borderColor: SP.line }}>
                <option value="">Whoever is free first</option>
                {s.staff.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error && (
            <p role="alert" className="rounded-xl p-3 text-[14px] font-medium text-white" style={{ background: SP.red }}>
              {error}
            </p>
          )}
          <PrimaryButton type="submit" disabled={!name.trim() || !phone.trim()} loading={join.isPending}>
            Join the queue
          </PrimaryButton>
          {s.onlineBookingEnabled && (
            <p className="text-center text-[14px]" style={{ color: SP.steel }}>
              Rather pick a time?{" "}
              <a href={`/salon/${locationId}`} className="font-semibold underline" style={{ color: SP.ink }}>
                Book an appointment
              </a>
            </p>
          )}
        </form>
      )}
    </Shell>
  );
}
