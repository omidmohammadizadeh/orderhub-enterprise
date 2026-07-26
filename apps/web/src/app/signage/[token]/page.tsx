"use client";

// Digital Signage — the full-screen menu board a TV opens by its unguessable
// token (no login). It polls the public render endpoint, which resolves the
// location's live POS menu, so prices + sold-out state always match the till.

import { useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { SignageBoard } from "@/lib/api/signage.client";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

function useWakeLock() {
  useEffect(() => {
    let lock: any = null;
    let released = false;
    const request = async () => {
      try {
        // navigator.wakeLock keeps the TV/tablet awake while the board shows.
        lock = await (navigator as any)?.wakeLock?.request?.("screen");
      } catch {
        /* not supported / denied — harmless */
      }
    };
    request();
    const onVisible = () => {
      if (document.visibilityState === "visible" && !released) request();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisible);
      try {
        lock?.release?.();
      } catch {
        /* ignore */
      }
    };
  }, []);
}

export default function SignageBoardPage() {
  const { token } = useParams<{ token: string }>();
  useWakeLock();

  const query = useQuery<SignageBoard>({
    queryKey: ["signage-board", token],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/v1/signage/public/${token}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Board not found");
      return res.json();
    },
    // Poll on the board's configured cadence (default 45s) — a no-login TV
    // can't join the JWT-gated sockets, and ≤60s lag is fine for a menu board.
    refetchInterval: (q) =>
      ((q.state.data?.display.config.refreshSeconds ?? 45) as number) * 1000,
    refetchOnWindowFocus: true,
  });

  const board = query.data;
  const dark = board?.display.config.theme !== "light";

  const rootRef = useRef<HTMLDivElement>(null);
  const goFullscreen = () => {
    rootRef.current?.requestFullscreen?.().catch(() => {});
  };

  if (query.isLoading) {
    return (
      <div className="grid h-screen place-items-center bg-black text-white">
        <p className="text-2xl opacity-70">Loading menu…</p>
      </div>
    );
  }
  if (query.isError || !board) {
    return (
      <div className="grid h-screen place-items-center bg-black text-white">
        <p className="text-2xl opacity-70">
          This screen isn&rsquo;t available.
        </p>
      </div>
    );
  }

  const portrait = board.display.orientation === "portrait";
  const columns = portrait
    ? 1
    : Math.min(Math.max(board.display.config.columns ?? 2, 1), 4);
  const showImages = board.display.config.showImages ?? false;
  const showLogo = board.display.config.showLogo ?? true;

  return (
    <div
      ref={rootRef}
      onClick={goFullscreen}
      className={`min-h-screen w-full overflow-hidden ${
        dark ? "bg-zinc-950 text-white" : "bg-white text-zinc-900"
      }`}
    >
      <header className="flex items-center gap-4 px-[3vw] pt-[3vh]">
        {showLogo && board.location.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={board.location.logoUrl}
            alt=""
            className="h-[7vh] w-auto rounded-lg object-contain"
          />
        ) : null}
        <h1 className="text-[4.5vh] font-bold tracking-tight">
          {board.display.name || board.location.name}
        </h1>
      </header>

      <main
        className="grid gap-x-[3vw] gap-y-[3vh] px-[3vw] py-[3vh]"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {board.categories.map((cat) => (
          <section key={cat.id} className="break-inside-avoid">
            <h2
              className={`mb-[1.4vh] border-b pb-[0.8vh] text-[3.2vh] font-semibold ${
                dark ? "border-white/15 text-amber-400" : "border-zinc-200 text-amber-600"
              }`}
            >
              {cat.name}
            </h2>
            <ul className="space-y-[1.2vh]">
              {cat.items.map((it, i) => (
                <li key={i} className="flex items-start gap-3">
                  {showImages && it.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={it.imageUrl}
                      alt=""
                      className="h-[6vh] w-[6vh] flex-shrink-0 rounded-md object-cover"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[2.6vh] font-medium">
                        {it.name}
                      </span>
                      {it.sizes && it.sizes.length ? null : (
                        <span className="text-[2.6vh] font-semibold tabular-nums">
                          £{(it.price ?? 0).toFixed(2)}
                        </span>
                      )}
                    </div>
                    {it.description ? (
                      <p
                        className={`text-[1.9vh] ${
                          dark ? "text-white/55" : "text-zinc-500"
                        }`}
                      >
                        {it.description}
                      </p>
                    ) : null}
                    {it.sizes && it.sizes.length ? (
                      <div className="mt-[0.4vh] flex flex-wrap gap-x-5 gap-y-1 text-[2.1vh]">
                        {it.sizes.map((s, j) => (
                          <span key={j} className="tabular-nums">
                            <span className={dark ? "text-white/60" : "text-zinc-500"}>
                              {s.name}
                            </span>{" "}
                            <span className="font-semibold">
                              £{s.price.toFixed(2)}
                            </span>
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
    </div>
  );
}
