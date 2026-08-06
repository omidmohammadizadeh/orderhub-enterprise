"use client";

// Type a name or draw one. Used by both ends — the operator placing their own
// countersignature and the client signing on a phone — so the two produce the
// same kind of artefact and the certificate can describe either honestly.
//
// A drawn signature is returned as a PNG data URL; a typed one as plain text.
// The caller decides which it wanted; both are legitimate under the Electronic
// Communications Act, and neither is more binding than the other.

import { useEffect, useRef, useState } from "react";
import { Check, Eraser, PenLine, Type, X } from "lucide-react";

export interface SignatureResult {
  /** Typed name — always set, since the certificate names a person. */
  name: string;
  /** PNG data URL when drawn, null when typed. */
  imageDataUrl: string | null;
}

export function SignaturePad({
  initialName = "",
  onCancel,
  onDone,
}: {
  initialName?: string;
  onCancel: () => void;
  onDone: (result: SignatureResult) => void;
}) {
  const [mode, setMode] = useState<"type" | "draw">("type");
  const [name, setName] = useState(initialName);
  const [hasInk, setHasInk] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);

  // Size the bitmap to the element so strokes land under the finger rather
  // than offset by the difference between CSS and device pixels.
  useEffect(() => {
    if (mode !== "draw") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#18181b";
    }
  }, [mode]);

  const pos = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawing.current = true;
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    setHasInk(true);
  };

  const end = () => {
    drawing.current = false;
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  };

  const done = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onDone({
      name: trimmed,
      imageDataUrl:
        mode === "draw" && hasInk
          ? (canvasRef.current?.toDataURL("image/png") ?? null)
          : null,
    });
  };

  // A name is required either way: a drawn squiggle alone identifies nobody,
  // and the certificate has to say who signed.
  const canSubmit = name.trim().length > 0 && (mode === "type" || hasInk);

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
      <div className="w-full rounded-t-2xl bg-white p-4 sm:max-w-md sm:rounded-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-900">Your signature</h3>
          <button
            onClick={onCancel}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-3 flex overflow-hidden rounded-lg border border-zinc-200">
          {(
            [
              { key: "type", label: "Type it", Icon: Type },
              { key: "draw", label: "Draw it", Icon: PenLine },
            ] as const
          ).map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMode(m.key)}
              className={`flex flex-1 items-center justify-center gap-1.5 py-2 text-sm font-semibold transition ${
                mode === m.key
                  ? "bg-zinc-900 text-white"
                  : "bg-white text-zinc-600"
              }`}
            >
              <m.Icon className="h-4 w-4" />
              {m.label}
            </button>
          ))}
        </div>

        <label className="mb-1 block text-xs font-medium text-zinc-600">
          Full name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sam Patel"
          autoFocus={mode === "type"}
          className="mb-3 w-full rounded-lg border border-zinc-200 px-3 py-2.5 text-base focus:border-zinc-900 focus:outline-none"
        />

        {mode === "type" ? (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-4">
            <p className="text-2xl italic text-zinc-900">
              {name.trim() || "Your name"}
            </p>
          </div>
        ) : (
          <div className="relative">
            <canvas
              ref={canvasRef}
              onPointerDown={start}
              onPointerMove={move}
              onPointerUp={end}
              onPointerLeave={end}
              // touch-none or the browser scrolls the page instead of drawing.
              className="h-40 w-full touch-none rounded-lg border border-zinc-200 bg-zinc-50"
            />
            <button
              type="button"
              onClick={clear}
              className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-white/90 px-2 py-1 text-[11px] font-semibold text-zinc-600 shadow-sm"
            >
              <Eraser className="h-3 w-3" />
              Clear
            </button>
            {!hasInk && (
              <p className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-zinc-400">
                Sign here
              </p>
            )}
          </div>
        )}

        <button
          onClick={done}
          disabled={!canSubmit}
          className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-lg bg-orange-500 px-3 py-3 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
        >
          <Check className="h-4 w-4" />
          Use this signature
        </button>
      </div>
    </div>
  );
}
