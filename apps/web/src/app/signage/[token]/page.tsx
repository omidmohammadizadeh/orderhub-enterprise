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

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { SignageBoard } from "@/lib/api/signage.client";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

// True when a hex colour is dark enough to need light text on top (used to pick
// readable accent/border/description colours for any chosen background).
function hexIsDark(hex?: string): boolean {
  if (!hex) return true;
  const m = hex.replace("#", "").trim();
  const s = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return true;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

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

/**
 * Which slide the board is showing.
 *
 * A screen can be the live menu (the original behaviour), a slideshow of
 * uploaded posters, or both alternating. Slides are modelled as a flat
 * list — "MENU" plus one entry per image — because that keeps MIXED from
 * needing any special case beyond a per-slide duration.
 *
 * Uses a chained timeout rather than setInterval: the menu and the images
 * hold for different lengths, so each slide has to schedule the next one
 * itself. These screens run unattended for weeks, so the timer is always
 * cleared on re-render — a leaked one would speed the board up every time
 * the 45s poll returned new data.
 */
function useSlides(
  mode: string | undefined,
  images: string[],
  imageSeconds: number,
  menuSeconds: number,
) {
  const slides = useMemo<string[]>(() => {
    if (mode === "IMAGES") return images.length ? images : [];
    if (mode === "MIXED" && images.length) return ["MENU", ...images];
    return [];
  }, [mode, images]);

  const [index, setIndex] = useState(0);

  // A shrinking image list (one deleted) must not strand the index past the
  // end, or the board goes blank until the next tick.
  const safeIndex = slides.length ? index % slides.length : 0;

  useEffect(() => {
    if (slides.length < 2) return;
    const current = slides[safeIndex];
    const ms = (current === "MENU" ? menuSeconds : imageSeconds) * 1000;
    const id = setTimeout(() => setIndex((i) => (i + 1) % slides.length), ms);
    return () => clearTimeout(id);
  }, [slides, safeIndex, imageSeconds, menuSeconds]);

  return { slides, current: slides.length ? slides[safeIndex] : null };
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

  // Background colour: an explicit config.background wins; otherwise the
  // light/dark theme default. `dark` (derived from the effective background)
  // drives the readable accent/border/description colours. Text colour
  // auto-adjusts for contrast unless config.text is set.
  const bgColor = board?.display.config.background;
  const dark = bgColor ? hexIsDark(bgColor) : board?.display.config.theme !== "light";
  const effectiveBg = bgColor ?? (dark ? "#09090b" : "#ffffff");
  const effectiveText =
    board?.display.config.text ?? (dark ? "#ffffff" : "#18181b");

  // Physical screen rotation (0/90/180/270) to match how the TV is mounted.
  const rotation = ((board?.display.config.rotation ?? 0) as number) % 360;
  const rotated = rotation === 90 || rotation === 270;

  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const portrait = board?.display.orientation === "portrait";
  const columns = portrait
    ? 1
    : Math.min(Math.max(board?.display.config.columns ?? 2, 1), 4);

  // Refit when the menu content, column count, or rotation changes (rotation
  // swaps the fit box's width/height, so the scaler must re-run).
  useFitToScreen(boxRef, contentRef, [
    board?.categories,
    columns,
    board?.display.orientation,
    rotation,
  ]);

  // Poster slides. Config lives on the board payload, so switching a screen
  // to images is a settings change the TV picks up on its next poll — no
  // one has to walk over and touch the television.
  const cfgImages = (board?.display.config.images ?? []).filter(Boolean);
  const { current: slide } = useSlides(
    board?.display.config.mode,
    cfgImages,
    Math.max(2, board?.display.config.imageSeconds ?? 10),
    Math.max(2, board?.display.config.menuSeconds ?? 20),
  );

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

  // MENU mode has no slides at all; in IMAGES/MIXED the slide is either the
  // literal "MENU" marker or an image URL. An IMAGES board with no artwork
  // yet falls through to the menu rather than showing a black screen.
  const posterSrc = slide && slide !== "MENU" ? slide : null;

  const showImages = board.display.config.showImages ?? false;
  const showLogo = board.display.config.showLogo ?? true;

  return (
    <div
      ref={rootRef}
      onClick={goFullscreen}
      // The physical screen (the "stage"). The board inside is rotated to match
      // how the TV is mounted; letterbox areas share the board background.
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: effectiveBg,
      }}
    >
    <div
      className="flex flex-col overflow-hidden"
      // For 90/270 the board is sized to the SWAPPED viewport (width=100vh,
      // height=100vw) then rotated, so it fills the screen. transforms don't
      // affect layout box size, so the fit scaler still measures correctly.
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        width: rotated ? "100vh" : "100vw",
        height: rotated ? "100vw" : "100vh",
        transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
        transformOrigin: "center center",
        background: effectiveBg,
        color: effectiveText,
      }}
    >
      {posterSrc ? (
        // Full-bleed poster. It sits INSIDE the rotated stage, so a screen
        // mounted portrait shows the artwork the right way up like the menu.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={posterSrc}
          alt=""
          style={{
            width: "100%",
            height: "100%",
            objectFit: board.display.config.imageFit ?? "contain",
            display: "block",
          }}
        />
      ) : (
      <>
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
      </>
      )}
      </div>
    </div>
  );
}
