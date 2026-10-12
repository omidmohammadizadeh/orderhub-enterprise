"use client";

// Your place in the walk-in queue, live. Refreshes on its own; the big
// number is the point — how many people are ahead of you.

import { useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { publicSalonClient } from "@/lib/api/salon.client";
import { GhostButton, SP, Shell, display } from "@/components/salon-public/salon-public-ui";

export default function QueueTicketPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["salon-public", "ticket", token],
    queryFn: () => publicSalonClient.ticket(token),
    enabled: !!token,
    refetchInterval: 20_000,
    retry: false,
  });
  const leave = useMutation({
    mutationFn: () => publicSalonClient.leave(token),
    onSuccess: (t) => qc.setQueryData(["salon-public", "ticket", token], t),
  });
  const t = q.data;

  // Buzz once when they're called — the phone is probably in a pocket.
  const buzzed = useRef(false);
  useEffect(() => {
    if (t?.status === "CALLED" && !buzzed.current) {
      buzzed.current = true;
      navigator.vibrate?.([200, 100, 200]);
    }
  }, [t?.status]);

  if (q.isLoading) {
    return (
      <Shell>
        <div className="h-72 animate-pulse rounded-2xl bg-white" />
      </Shell>
    );
  }
  if (!t) {
    return (
      <Shell>
        <p className={`text-3xl ${display}`}>We couldn&rsquo;t find your place.</p>
      </Shell>
    );
  }
  const called = t.status === "CALLED";
  const seated = t.status === "IN_SERVICE" || t.status === "DONE";
  const gone = t.status === "LEFT";
  return (
    <Shell>
      <p className="text-[15px] font-semibold" style={{ color: SP.steel }}>
        {t.locationName}
      </p>
      <section
        className="mt-3 rounded-3xl px-6 py-8 text-center"
        style={{ background: called ? SP.brass : SP.ink, color: "white" }}
        aria-live="polite"
      >
        {called ? (
          <>
            <p className={`text-[3.2rem] leading-none ${display}`}>You&rsquo;re up!</p>
            <p className="mt-3 text-[17px]">{t.staffName ? `${t.staffName} is ready for you.` : "Head to the front desk."}</p>
          </>
        ) : seated ? (
          <p className={`text-[2.4rem] leading-none ${display}`}>Enjoy your cut, {t.customerName.split(" ")[0]}</p>
        ) : gone ? (
          <p className={`text-[2.4rem] leading-none ${display}`}>You&rsquo;ve left the queue</p>
        ) : (
          <>
            <p className="text-[14px] opacity-75">{t.ahead === 0 ? "You're next" : "People ahead of you"}</p>
            <p className={`text-[6rem] leading-none ${display}`}>{t.ahead === 0 ? "1st" : t.ahead}</p>
            <p className="mt-2 text-[17px]">
              {!t.openNow && t.opensAt
                ? `We open at ${new Date(t.opensAt).toLocaleTimeString("en-GB", { timeZone: t.timezone, hour: "2-digit", minute: "2-digit" })}`
                : t.waitMins === null
                  ? "We'll fit you in as soon as we can"
                  : t.waitMins <= 5
                    ? "Any minute now"
                    : t.waitMins < 60
                      ? `About ${Math.round(t.waitMins / 5) * 5} minutes`
                      : `About ${Math.floor(t.waitMins / 60)}h ${Math.round((t.waitMins % 60) / 5) * 5}m`}
              {t.staffName ? ` · likely ${t.staffName}` : ""}
            </p>
          </>
        )}
      </section>
      {!called && !seated && !gone && (
        <p className="mt-4 text-center text-[14px]" style={{ color: SP.steel }}>
          This page updates itself. Pop out for a coffee — just keep an eye on it.
        </p>
      )}
      {(t.status === "WAITING" || t.status === "CALLED") && (
        <div className="mt-6 flex justify-center">
          <GhostButton danger onClick={() => confirm("Leave the queue?") && leave.mutate()}>
            Leave the queue
          </GhostButton>
        </div>
      )}
      {gone && (
        <a href={`/salon/${t.locationId}/queue`} className="mt-6 block text-center font-semibold underline">
          Join again
        </a>
      )}
    </Shell>
  );
}
