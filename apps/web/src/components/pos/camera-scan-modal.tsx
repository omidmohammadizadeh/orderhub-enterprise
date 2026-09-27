"use client";

// Retail R1 — scan with the tablet's camera when there is no scanner.
//
// Uses the browser's own BarcodeDetector (Chrome / Android WebView — i.e. the
// Sunmi and Android tablets shops actually use). Where it doesn't exist the
// till simply doesn't offer this button; a £25 USB scanner is the better tool
// anyway. Detection runs on a timer, not requestAnimationFrame, which stops
// dead in a background tab.

import { useEffect, useRef, useState } from "react";
import { Camera, X } from "lucide-react";

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"];

export function isCameraScanSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "BarcodeDetector" in window &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export function CameraScanModal({
  title = "Scan with camera",
  onDetected,
  onClose,
}: {
  title?: string;
  onDetected: (code: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const cb = useRef(onDetected);
  cb.current = onDetected;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    (async () => {
      try {
        const Detector = (window as any).BarcodeDetector;
        const supported: string[] = (await Detector.getSupportedFormats?.()) ?? FORMATS;
        const detector = new Detector({ formats: FORMATS.filter((f) => supported.includes(f)) });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) return;
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();

        const tick = async () => {
          if (cancelled || done.current) return;
          try {
            if (video.readyState >= 2) {
              const hits = await detector.detect(video);
              const code = hits?.[0]?.rawValue as string | undefined;
              if (code) {
                done.current = true;
                cb.current(code);
                return;
              }
            }
          } catch {
            /* a frame that fails to decode — try the next one */
          }
          timer = setTimeout(tick, 150);
        };
        void tick();
      } catch (err: any) {
        setError(
          err?.name === "NotAllowedError"
            ? "Camera access was refused. Allow the camera for this site, or use a barcode scanner."
            : "Couldn't start the camera on this device.",
        );
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-md overflow-hidden rounded-xl bg-white" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <Camera className="h-4 w-4" /> {title}
          </h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        {error ? (
          <p className="p-6 text-center text-sm text-red-600">{error}</p>
        ) : (
          <div className="relative bg-black">
            <video ref={videoRef} playsInline muted className="aspect-[4/3] w-full object-cover" />
            {/* Aiming guide */}
            <div className="pointer-events-none absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded-lg border-2 border-white/80" />
          </div>
        )}
        <p className="px-4 py-3 text-center text-xs text-zinc-500">Hold the barcode inside the box.</p>
      </div>
    </div>
  );
}
