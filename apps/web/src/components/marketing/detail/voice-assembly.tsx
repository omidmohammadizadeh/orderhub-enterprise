"use client";

// The centrepiece of the AI phone line page: one call, shown in pieces and put
// back together as the visitor scrolls. Four pieces — the ringing call, what
// the caller said, the order it became and the kitchen ticket — start
// scattered in depth and dock edge to edge into one strip, the way the call
// really does become a ticket.
//
// Scroll drives ONE CSS variable, --p (0 → 1), written straight onto the stage
// from a passive, rAF-throttled listener. Every transform is CSS calc() off
// that variable, so scrolling never re-renders React. The only React state is
// which of the four steps is current, and that changes four times.
//
// Reduced motion gets the finished strip, no pinned scroll: --p is fixed at 1
// by a motion-reduce class and the listener is never attached.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, PhoneIncoming } from "lucide-react";

type Piece = {
  /** When its flight starts and how long it takes, as a share of the scroll. */
  start: number;
  span: number;
  /** Its docked position in the strip, and its height. */
  top: number;
  height: number;
  /** Where it starts, relative to where it docks. */
  from: { x: number; y: number; z: number; rx: number; rz: number };
};

// Scattered BEHIND the stage (negative z), not in front of it. In front, a
// piece in flight is enlarged by the perspective and swells across the step
// list beside it; the first version covered that copy on desktop.
//
// Behind has its own catch: the stage is turned (rotateY below), and turning
// a stage swings anything set deep behind it sideways, to the right, by
// depth × sin(turn). Deep pieces ran off the right edge of both screens. So
// depth and turn are kept shallow, and the x offsets lean LEFT to cancel the
// swing: net drift alternates left and right around the strip's own column.
//
// The stage is tilted back too (rotateX), which does the same thing
// vertically: a deep piece drops by roughly depth × tan(tilt), about 0.6px
// per 1px of depth, and the ticket hung off the bottom of the screen. The y
// offsets start each piece that much higher, so the scattered set sits in
// the middle of the stage instead of sinking below it.
const PIECES: Piece[] = [
  { start: 0.0, span: 0.2, top: 0, height: 88, from: { x: -140, y: -260, z: -380, rx: 34, rz: -14 } },
  { start: 0.2, span: 0.2, top: 88, height: 104, from: { x: -45, y: -210, z: -320, rx: -28, rz: 12 } },
  { start: 0.4, span: 0.2, top: 192, height: 152, from: { x: -120, y: -190, z: -360, rx: 30, rz: -10 } },
  { start: 0.6, span: 0.24, top: 344, height: 184, from: { x: -65, y: -210, z: -420, rx: -32, rz: 14 } },
];
const STRIP_HEIGHT = 528;

const STEPS = [
  { title: "The phone rings out", body: "Nobody at the counter is free, so the call comes to the AI line and it answers." },
  { title: "It understands the order", body: "What they say is matched to your real menu, with sizes and paid extras priced." },
  { title: "It reads it back", body: "Every item and the total are read back. Nothing is placed until they say yes." },
  { title: "It prints in the kitchen", body: "The order lands on your board with every other order and the ticket prints." },
];

const WAVE = [10, 22, 14, 30, 18, 34, 12, 26, 16, 28, 9, 20];

function pieceStyle(p: Piece): CSSProperties {
  const k = "(1 - var(--t))";
  return {
    ["--t" as string]: `clamp(0, calc((var(--p) - ${p.start}) / ${p.span}), 1)`,
    height: p.height,
    transform:
      `translate3d(calc(${k} * ${p.from.x}px), calc(${p.top}px + ${k} * ${p.from.y}px), calc(${k} * ${p.from.z}px)) ` +
      `rotateX(calc(${k} * ${p.from.rx}deg)) rotateZ(calc(${k} * ${p.from.rz}deg))`,
    opacity: "calc(0.35 + 0.65 * var(--t))",
  } as CSSProperties;
}

function Seam({ accent }: { accent: string }) {
  // Lights up as the piece docks against the one above it.
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-5 -top-px h-px"
      style={{ background: accent, boxShadow: `0 0 14px ${accent}`, opacity: "var(--t)" }}
    />
  );
}

export function VoiceAssembly({ accent }: { accent: string }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stepRef = useRef(0);
  const [step, setStep] = useState(0);

  useEffect(() => {
    const wrap = wrapRef.current;
    const sticky = stickyRef.current;
    const stage = stageRef.current;
    if (!wrap || !sticky || !stage) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      stepRef.current = STEPS.length - 1;
      setStep(STEPS.length - 1);
      return;
    }
    let frame = 0;
    // The strip pins BELOW the site header, not at the very top of the window,
    // so progress runs from the moment it pins to the moment it lets go. The
    // pinned offset is a style read, so it is taken once and on resize only.
    let pinnedAt = parseFloat(getComputedStyle(sticky).top) || 0;
    const update = () => {
      frame = 0;
      const rect = wrap.getBoundingClientRect();
      const travel = rect.height - sticky.offsetHeight;
      const p = travel > 0 ? Math.min(1, Math.max(0, (pinnedAt - rect.top) / travel)) : 1;
      stage.style.setProperty("--p", p.toFixed(4));
      let next = 0;
      for (let i = 0; i < PIECES.length; i++) if (p >= PIECES[i]!.start) next = i;
      if (next !== stepRef.current) {
        stepRef.current = next;
        setStep(next);
      }
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onResize = () => {
      pinnedAt = parseFloat(getComputedStyle(sticky).top) || 0;
      onScroll();
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section className="relative border-b border-white/10">
      <div ref={wrapRef} className="relative h-[300vh] motion-reduce:h-auto">
        <div
          ref={stickyRef}
          className="sticky top-[69px] flex h-[calc(100svh-69px)] items-center overflow-hidden motion-reduce:static motion-reduce:h-auto motion-reduce:py-24"
        >
          <div className="mx-auto grid w-full max-w-6xl items-center gap-6 px-4 lg:grid-cols-[1fr_1.15fr] lg:gap-12">
            <div>
              <h2 className="max-w-md text-balance text-3xl font-bold tracking-tight text-white sm:text-4xl">
                From a ringing phone to a kitchen ticket
              </h2>
              <p className="mt-3 max-w-md text-[15px] leading-relaxed text-zinc-400">
                One call, piece by piece.
              </p>

              {/* Phone and tablet: just the current step. */}
              <div className="mt-5 lg:hidden" aria-live="polite">
                <p className="text-sm font-semibold text-white">
                  <span style={{ color: accent }}>{step + 1}.</span> {STEPS[step]!.title}
                </p>
                <p className="mt-1 max-w-md text-sm leading-relaxed text-zinc-400">{STEPS[step]!.body}</p>
              </div>

              {/* Desktop: the whole sequence, current step lit. */}
              <ol className="mt-10 hidden space-y-6 lg:block">
                {STEPS.map((s, i) => {
                  const lit = i <= step;
                  return (
                    <li
                      key={s.title}
                      className={`flex gap-4 transition-opacity duration-300 motion-reduce:opacity-100 ${
                        i === step ? "opacity-100" : lit ? "opacity-70" : "opacity-35"
                      }`}
                    >
                      <span
                        className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full border text-sm font-bold"
                        style={{
                          borderColor: lit ? accent : "rgba(255,255,255,0.15)",
                          color: lit ? accent : "rgb(113,113,122)",
                          background: "#070a12",
                        }}
                      >
                        {i + 1}
                      </span>
                      <span>
                        <span className="block text-[15px] font-semibold text-white">{s.title}</span>
                        <span className="mt-1 block max-w-sm text-sm leading-relaxed text-zinc-400">{s.body}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>

            <div className="relative flex justify-center [perspective:1400px]">
              <div
                aria-hidden
                className="absolute left-1/2 top-1/2 -z-10 h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
                style={{ background: `radial-gradient(circle, ${accent}2e, transparent 70%)` }}
              />
              <div className="origin-center scale-[0.82] sm:scale-90 lg:scale-100">
                <div
                  ref={stageRef}
                  aria-hidden
                  className="relative w-[320px] [--p:0] [transform-style:preserve-3d] motion-reduce:[--p:1]"
                  style={{
                    height: STRIP_HEIGHT,
                    transform: "rotateX(calc(32deg - var(--p) * 22deg)) rotateY(calc(-16deg + var(--p) * 6deg))",
                  }}
                >
                  {/* 1. The call */}
                  <div
                    className="absolute inset-x-0 top-0 overflow-hidden rounded-t-2xl border border-white/10 bg-[#11152a] px-4 will-change-transform"
                    style={pieceStyle(PIECES[0]!)}
                  >
                    <div className="flex h-full items-center gap-3">
                      <span
                        className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-full"
                        style={{ background: `${accent}26`, color: accent }}
                      >
                        <PhoneIncoming className="h-5 w-5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-white">Incoming call</span>
                        <span className="block text-xs tabular-nums text-zinc-400">07700 900482</span>
                      </span>
                      <span className="ml-auto flex h-9 items-center gap-[3px]">
                        {WAVE.map((h, i) => (
                          <span key={i} className="w-[3px] rounded-full" style={{ height: h, background: accent }} />
                        ))}
                      </span>
                    </div>
                  </div>

                  {/* 2. What they said */}
                  <div
                    className="absolute inset-x-0 top-0 border-x border-b border-white/10 bg-[#0e1224] px-4 py-3.5 will-change-transform"
                    style={pieceStyle(PIECES[1]!)}
                  >
                    <Seam accent={accent} />
                    <p className="text-[11px] text-zinc-500">The caller said</p>
                    <p className="mt-1 text-[13px] leading-snug text-zinc-200">
                      &ldquo;A large pepperoni with extra mushrooms, and a garlic bread. Collection, please.&rdquo;
                    </p>
                  </div>

                  {/* 3. The order */}
                  <div
                    className="absolute inset-x-0 top-0 border-x border-b border-white/10 bg-[#0b0f1f] px-4 py-3.5 will-change-transform"
                    style={pieceStyle(PIECES[2]!)}
                  >
                    <Seam accent={accent} />
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] text-zinc-500">Read back and confirmed</p>
                      <Check className="h-4 w-4" style={{ color: accent }} />
                    </div>
                    <div className="mt-2 space-y-1 text-[13px] tabular-nums">
                      <p className="flex justify-between text-zinc-200"><span>1 × Large pepperoni</span><span>£11.50</span></p>
                      <p className="flex justify-between pl-4 text-zinc-400"><span>Extra mushrooms</span><span>£1.20</span></p>
                      <p className="flex justify-between text-zinc-200"><span>1 × Garlic bread</span><span>£3.90</span></p>
                    </div>
                    <p className="mt-2 flex justify-between border-t border-white/10 pt-2 text-[13px] font-semibold tabular-nums text-white">
                      <span>Collection</span><span>£16.60</span>
                    </p>
                  </div>

                  {/* 4. The kitchen ticket */}
                  <div
                    className="absolute inset-x-0 top-0 rounded-b-2xl bg-zinc-100 px-5 py-3.5 font-mono text-zinc-900 will-change-transform"
                    style={pieceStyle(PIECES[3]!)}
                  >
                    <Seam accent={accent} />
                    <p className="text-center text-[13px] font-bold">AI VOICE</p>
                    <p className="text-center text-[11px]">#W45QN &nbsp; COLLECTION</p>
                    <div className="my-2 border-t border-dashed border-zinc-400" />
                    <div className="space-y-0.5 text-[11px] tabular-nums">
                      <p className="flex justify-between"><span>1 LARGE PEPPERONI</span><span>11.50</span></p>
                      <p className="pl-3">+ EXTRA MUSHROOMS</p>
                      <p className="flex justify-between"><span>1 GARLIC BREAD</span><span>3.90</span></p>
                    </div>
                    <div className="my-2 border-t border-dashed border-zinc-400" />
                    <p className="flex justify-between text-[12px] font-bold tabular-nums"><span>TOTAL</span><span>£16.60</span></p>
                    <p className="mt-1 text-center text-[10px]">CASH ON COLLECTION</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
