"use client";

// Digital Signage — the full-screen menu board a TV opens by its unguessable
// token (no login). It polls the public render endpoint, which resolves the
// location's live POS menu, so prices + sold-out state always match the till.
//
// TV layout rules (customers can't scroll):
//   • Items flow in NEWSPAPER COLUMNS — fill down one column, continue into the
//     next column, and the next category stacks underneath when there's room
//     (CSS multi-column).
//   • Everything must fit on screen — a fit-to-screen scaler binary-searches the
//     largest font size at which all content fits the viewport (no scroll, no
//     clipping), adapting to the screen size and how many items there are.

import { useEffect, useLayoutEffect, useRef } from "react";
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

// Grow/shrink the board's base font size so all content fits the box in both
// axes — no scrolling, no clipping. Re-runs whenever the menu or size changes.
function useFitToScreen(
  boxRef: React.RefObject<HTMLDivElement | null>,
  contentRef: React.RefObject<HTMLDivElement | null>,
  deps: unknown[],
) {
  const fit = () => {
    const box = boxRef.current;
    const el = contentRef.current;
    if (!box || !el) return;
    // Require a few px of clearance so an item at a column's bottom edge is
    // never clipped by sub-pixel rounding.
    const PAD = 6;
    const fits = () =>
      el.scrollHeight <= box.clientHeight - PAD &&
      el.scrollWidth <= box.clientWidth - PAD;
    // Binary-search the largest px font size that still fits.
    let lo = 6;
    let hi = Math.max(14, Math.floor(box.clientHeight / 5));
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      el.style.fontSize = `${mid}px`;
      if (fits()) lo = mid;
      else hi = mid;
    }
    el.style.fontSize = `${lo}px`;
  };
  // Layout effect so the measure happens before paint (no flash of overflow).
  useLayoutEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    const onResize = () => fit();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const boxRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const portrait = board?.display.orientation === "portrait";
  const columns = portrait
    ? 1
    : Math.min(Math.max(board?.display.config.columns ?? 2, 1), 4);

  // Refit when the menu content or column count changes.
  useFitToScreen(boxRef, contentRef, [
    board?.categories,
    columns,
    board?.display.orientation,
  ]);

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

  const showImages = board.display.config.showImages ?? false;
  const showLogo = board.display.config.showLogo ?? true;

  return (
    <div
      ref={rootRef}
      onClick={goFullscreen}
      className={`flex h-screen w-screen flex-col overflow-hidden ${
        dark ? "bg-zinc-950 text-white" : "bg-white text-zinc-900"
      }`}
    >
      <header className="flex shrink-0 items-center gap-4 px-[3vw] pb-[1vh] pt-[2.5vh]">
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

      {/* Fit box: the scaler keeps contentRef within these bounds. */}
      <div ref={boxRef} className="min-h-0 flex-1 overflow-hidden px-[3vw] pb-[2.5vh]">
        <div
          ref={contentRef}
          // Multi-column newspaper flow: items fill down a column then continue
          // in the next; categories stack underneath in the flow. Font size is
          // set by the fit scaler; all inner sizes are em-relative so they scale.
          style={{
            columnCount: columns,
            columnGap: "2.5vw",
            fontSize: "24px", // replaced by the scaler on mount
            lineHeight: 1.25,
          }}
        >
          {board.categories.map((cat) => (
            <section key={cat.id} className="mb-[1.1em]">
              <h2
                className={`mb-[0.5em] border-b pb-[0.25em] text-[1.5em] font-semibold ${
                  dark
                    ? "border-white/15 text-amber-400"
                    : "border-zinc-200 text-amber-600"
                }`}
                // Keep the heading with the first items (no orphan heading at a
                // column bottom).
                style={{ breakAfter: "avoid", breakInside: "avoid" }}
              >
                {cat.name}
              </h2>
              <ul>
                {cat.items.map((it, i) => (
                  <li
                    key={i}
                    className="mb-[0.55em] flex items-start gap-[0.6em]"
                    // Never split a single item across two columns.
                    style={{ breakInside: "avoid" }}
                  >
                    {showImages && it.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={it.imageUrl}
                        alt=""
                        className="h-[2.4em] w-[2.4em] flex-shrink-0 rounded-md object-cover"
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-[0.6em]">
                        <span className="text-[1.15em] font-medium">
                          {it.name}
                        </span>
                        {it.sizes && it.sizes.length ? null : (
                          <span className="text-[1.15em] font-semibold tabular-nums">
                            £{(it.price ?? 0).toFixed(2)}
                          </span>
                        )}
                      </div>
                      {it.description ? (
                        <p
                          className={`text-[0.85em] ${
                            dark ? "text-white/55" : "text-zinc-500"
                          }`}
                        >
                          {it.description}
                        </p>
                      ) : null}
                      {it.sizes && it.sizes.length ? (
                        <div className="mt-[0.15em] flex flex-wrap gap-x-[1.1em] gap-y-[0.15em] text-[0.95em]">
                          {it.sizes.map((s, j) => (
                            <span key={j} className="tabular-nums">
                              <span
                                className={dark ? "text-white/60" : "text-zinc-500"}
                              >
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
        </div>
      </div>
    </div>
  );
}
