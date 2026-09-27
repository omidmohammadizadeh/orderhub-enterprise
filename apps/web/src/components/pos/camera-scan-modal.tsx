"use client";

// Retail R1 — scan with the tablet's camera when there is no scanner.
//
// Two decoders, same result:
//   • the browser's own BarcodeDetector where it exists (Chrome / Android
//     WebView — the Sunmi and Android tablets shops mostly use): fast, free;
//   • ZXing (@zxing/browser, pure JS) everywhere else — iPad Safari and the
//     iOS app's WKWebView have no BarcodeDetector at all. Loaded only when the
//     camera opens on such a device, so it costs the till's bundle nothing.
// Both run on timers, never requestAnimationFrame, which stops dead in a
// background tab.
//
// Inside the OrderHub tablet app the camera needs the native permission
// (CAMERA on Android, NSCameraUsageDescription on iOS — see apps/mobile).

import { useEffect, useRef, useState } from "react";
import { Camera, X } from "lucide-react";

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"];

/** Anything with a camera the page may open — the decoder is sorted out later. */
export function isCameraScanSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext !== false &&
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
    let zxingControls: { stop: () => void } | null = null;
    let cancelled = false;

    const found = (code: string | undefined | null) => {
      if (!code || done.current || cancelled) return;
      done.current = true;
      cb.current(code);
    };

    const openCamera = () =>
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });

    (async () => {
      try {
        try {
          stream = await openCamera();
        } catch (err: any) {
          // The Android app asks for the camera the first time, and Android's
          // permission dialog pauses the app — which cancels the WebView's
          // request, so this first try is refused even when the person taps
          // Allow. The permission IS granted by now; ask once more.
          if (err?.name !== "NotAllowedError" || cancelled) throw err;
          await new Promise((r) => setTimeout(r, 700));
          if (cancelled) return;
          stream = await openCamera();
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current!;

        const Detector = (window as any).BarcodeDetector;
        if (Detector) {
          const supported: string[] = (await Detector.getSupportedFormats?.()) ?? FORMATS;
          const detector = new Detector({ formats: FORMATS.filter((f) => supported.includes(f)) });
          video.srcObject = stream;
          await video.play();
          const tick = async () => {
            if (cancelled || done.current) return;
            try {
              if (video.readyState >= 2) {
                const hits = await detector.detect(video);
                found(hits?.[0]?.rawValue as string | undefined);
                if (done.current) return;
              }
            } catch {
              /* a frame that fails to decode — try the next one */
            }
            timer = setTimeout(tick, 150);
          };
          void tick();
          return;
        }

        // No native detector (iPad / iOS app): decode with ZXing.
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        if (cancelled) return;
        const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 150 });
        zxingControls = await reader.decodeFromStream(stream, video, (result) => {
          if (result) found(result.getText());
        });
        if (cancelled) zxingControls.stop();
      } catch (err: any) {
        setError(
          err?.name === "NotAllowedError"
            ? "Camera access was refused. Allow the camera for OrderHub (in the tablet's settings for the app, or the browser's site settings), or use a barcode scanner."
            : "Couldn't start the camera on this device.",
        );
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      zxingControls?.stop();
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
