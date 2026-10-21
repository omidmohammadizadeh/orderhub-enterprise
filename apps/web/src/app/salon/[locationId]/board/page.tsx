"use client";

// The screen by the door: the walk-in wait in letters you can read from
// the pavement, who's being seen, who's next, and a QR to join from a
// phone. First names only — this faces the street.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { publicSalonClient } from "@/lib/api/salon.client";
import { SP, display } from "@/components/salon-public/salon-public-ui";

function wait(m: number | null): string {
  if (m === null) return "Full today";
  if (m <= 5) return "Walk straight in";
  if (m < 60) return `${Math.round(m / 5) * 5} min wait`;
  const h = Math.floor(m / 60);
  const r = Math.round((m % 60) / 5) * 5;
  return `${h}h${r ? ` ${r}m` : ""} wait`;
}

function short(m: number | null): string {
  if (m === null) return "";
  if (m <= 5) return "next";
  if (m < 60) return `~${Math.round(m / 5) * 5}m`;
  return `~${Math.floor(m / 60)}h${Math.round((m % 60) / 5) * 5 ? ` ${Math.round((m % 60) / 5) * 5}m` : ""}`;
}

export default function QueueBoardPage() {
  const params = useParams<{ locationId: string }>();
  const locationId = params?.locationId ?? "";
  const q = useQuery({
    queryKey: ["salon-public", "board", locationId],
    queryFn: () => publicSalonClient.queueBoard(locationId),
    enabled: !!locationId,
    refetchInterval: 15_000,
    retry: true,
  });
  const [joinUrl, setJoinUrl] = useState("");
  useEffect(() => setJoinUrl(`${window.location.origin}/salon/${locationId}/queue`), [locationId]);
  const [clock, setClock] = useState("");
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }));
    tick();
    const t = window.setInterval(tick, 15_000);
    return () => window.clearInterval(t);
  }, []);
  const b = q.data;

  return (
    <main className="min-h-screen p-[3vw] text-white" style={{ background: SP.ink, fontFamily: "var(--font-salon)" }}>
      <div className="flex items-start justify-between gap-6">
        <h1 className={`text-[4.2vw] leading-none ${display}`}>{b?.locationName ?? ""}</h1>
        <p className={`text-[3vw] leading-none tabular-nums opacity-70 ${display}`}>{clock}</p>
      </div>
      <div className="mt-[2vw] h-[0.6vw] rounded-full" style={{ backgroundImage: `repeating-linear-gradient(-45deg, ${SP.red} 0 1.2vw, #fff 1.2vw 2.4vw, ${SP.blue} 2.4vw 3.6vw, #fff 3.6vw 4.8vw)` }} />

      {!b ? null : !b.queueEnabled ? (
        <p className={`mt-[6vw] text-[6vw] ${display}`}>Appointments only today</p>
      ) : (
        <div className="mt-[3vw] grid grid-cols-[1.2fr_1fr] gap-[3vw]">
          <section>
            <p className="text-[1.6vw] opacity-70">Walk-ins</p>
            <p className={`text-[9vw] leading-[0.9] ${display}`} style={{ color: "#E7C277" }}>
              {!b.openNow && b.opensAt
                ? `Opens ${new Date(b.opensAt).toLocaleTimeString("en-GB", { timeZone: b.timezone, hour: "2-digit", minute: "2-digit" })}`
                : wait(b.nextWaitMins)}
            </p>
            <p className="mt-[1vw] text-[1.8vw] opacity-80">
              {b.waiting.length} waiting · {b.barbersOn.length} in today
              {b.barbersOn.length ? `: ${b.barbersOn.map((x) => x.name).join(", ")}` : ""}
            </p>
            {b.nowServing.length > 0 && (
              <div className="mt-[3vw]">
                <p className="text-[1.6vw] opacity-70">Now</p>
                <ul className="mt-[0.6vw] space-y-[0.6vw]">
                  {b.nowServing.map((n, i) => (
                    <li key={i} className={`text-[3vw] leading-tight ${display}`}>
                      {n.name}
                      <span className="text-[2vw] font-normal opacity-70"> {n.status === "CALLED" ? "— please come up" : n.staffName ? `with ${n.staffName}` : ""}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
          <section className="flex flex-col justify-between gap-[2vw]">
            <div>
              <p className="text-[1.6vw] opacity-70">Up next</p>
              <ol className="mt-[0.6vw] space-y-[0.5vw]">
                {b.waiting.slice(0, 6).map((w) => (
                  <li key={`${w.position}-${w.name}`} className="flex items-baseline gap-[1vw] text-[2.4vw]">
                    <span className={`w-[3vw] opacity-60 ${display}`}>{w.position}</span>
                    <span className={`flex-1 ${display}`}>{w.name}</span>
                    <span className="text-[1.6vw] tabular-nums opacity-70">{!b.openNow ? "" : short(w.waitMins)}</span>
                  </li>
                ))}
                {b.waiting.length === 0 && <li className="text-[2vw] opacity-60">Nobody waiting</li>}
              </ol>
            </div>
            {b.onlineJoin && joinUrl && (
              <div className="flex items-center gap-[2vw] rounded-[1.5vw] bg-white p-[1.5vw] text-zinc-900">
                <QRCodeSVG value={joinUrl} size={512} level="M" marginSize={0} style={{ width: "11vw", height: "11vw" }} />
                <p className={`text-[2.2vw] leading-tight ${display}`}>Scan to join the queue from your phone</p>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
