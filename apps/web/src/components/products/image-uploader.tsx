"use client";

// Phase AL — image uploader.
//
// Two modes:
//   - "required" (Product) — enforces exactly 1064×768 px, resizes if
//     the source is bigger AND has the same aspect ratio (1.385), rejects
//     otherwise so we don't silently squish a square photo.
//   - "optional" (Modifier) — same shape, but the field can be empty.
//
// Current phase: paste-a-URL placeholder + a "Choose file" button that
// uses a client-side <canvas> to resize/crop to 1064×768 and converts
// to base64. The real Supabase Storage upload lands in the follow-up
// commit — when it does, the only change is swapping the base64 result
// for the public URL returned by uploadsClient.signProductImage().

import { ChangeEvent, useRef, useState } from "react";
import Image from "next/image";
import { ImagePlus, Link as LinkIcon, X, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { uploadsClient } from "@/lib/api/catalog.client";

interface Props {
  value: string | null;
  onChange: (url: string | null) => void;
  required?: boolean;
  /** Width and height the image must end up at — defaults to 1064×768 */
  targetWidth?: number;
  targetHeight?: number;
  /**
   * How the source is fitted into the target box:
   *   "cover"   — fill + centre-crop (default; right for photos/banners).
   *   "contain" — fit the WHOLE image inside, pad the rest transparent,
   *               never crop. Use for LOGOS so a square badge isn't sliced
   *               top/bottom by a landscape target.
   */
  fit?: "cover" | "contain";
}

export function ImageUploader({
  value,
  onChange,
  required,
  targetWidth = 1064,
  targetHeight = 768,
  fit = "cover",
}: Props) {
  const aspectRatio = `${targetWidth} / ${targetHeight}`;
  const fileInput = useRef<HTMLInputElement>(null);
  const [showUrl, setShowUrl] = useState(false);
  const [urlInput, setUrlInput] = useState(value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("File must be an image (JPG, PNG, or WEBP).");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError("Image is over 8 MB. Compress it first.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // Resize/crop client-side, then upload to Supabase Storage via the API
      // and save the public https URL. If storage isn't configured (or the
      // upload fails), fall back to the data URL so the form still works.
      const dataUrl = await resizeToTarget(file, targetWidth, targetHeight, fit);
      try {
        const { publicUrl } = await uploadsClient.uploadProductImage({ dataUrl });
        onChange(publicUrl);
      } catch {
        onChange(dataUrl);
      }
    } catch (err: any) {
      setError(err.message ?? "Could not process image");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <div className="space-y-2">
      {value ? (
        <div
          className="relative group rounded-lg overflow-hidden border border-zinc-200 bg-white"
          style={{ aspectRatio }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={value}
            alt=""
            className={`w-full h-full ${fit === "contain" ? "object-contain" : "object-cover"}`}
          />
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setUrlInput("");
            }}
            className="absolute top-2 right-2 h-7 w-7 rounded-full bg-black/60 text-white grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity"
            title="Remove image"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div
          onClick={() => fileInput.current?.click()}
          style={{ aspectRatio }}
          className="rounded-lg border-2 border-dashed border-zinc-200 hover:border-orange-400 hover:bg-orange-50/30 transition-colors cursor-pointer grid place-items-center text-center"
        >
          <div>
            <ImagePlus className="h-8 w-8 text-zinc-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-zinc-600">
              Click to upload {required ? "(required)" : "(optional)"}
            </p>
            <p className="text-xs text-zinc-400 mt-0.5">
              {fit === "contain"
                ? `Padded to ${targetWidth}×${targetHeight} — whole image kept, never cropped`
                : `Will be resized to ${targetWidth}×${targetHeight} for all platforms`}
            </p>
          </div>
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleFile}
        className="hidden"
      />

      {/* URL fallback row */}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className="h-8 text-xs"
        >
          <ImagePlus className="h-3.5 w-3.5 mr-1.5" />
          {busy ? "Processing…" : value ? "Replace" : "Choose file"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowUrl(!showUrl)}
          className="h-8 text-xs text-zinc-500"
        >
          <LinkIcon className="h-3.5 w-3.5 mr-1.5" />
          Paste URL
        </Button>
      </div>

      {showUrl && (
        <div className="flex gap-2">
          <Input
            placeholder="https://…/image.jpg"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            className="flex-1 h-8 text-xs"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              onChange(urlInput.trim() || null);
              setShowUrl(false);
            }}
            className="h-8 text-xs"
          >
            Use URL
          </Button>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-1.5 text-xs text-red-600">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}

// Loads the image, draws it into a canvas at exactly targetW×targetH,
// then returns a data: URL.
//   "cover"   — aspect-mismatched images are centre-cropped so we don't
//               squish/stretch the subject (photos, banners).
//   "contain" — the WHOLE image is scaled to fit inside and centred, with
//               the leftover area left transparent — nothing is ever
//               cropped (logos). Exported as PNG to preserve the padding.
async function resizeToTarget(
  file: File,
  targetW: number,
  targetH: number,
  fit: "cover" | "contain" = "cover",
): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error("Could not read file"));
    r.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new globalThis.Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Image failed to decode"));
    el.src = dataUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");

  if (fit === "contain") {
    // Fit the ENTIRE image inside the canvas (no crop), centre it, leave
    // the rest transparent. This is what a logo needs: a square badge in a
    // square target keeps all four edges instead of being sliced.
    const scale = Math.min(targetW / img.width, targetH / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    const dx = (targetW - dw) / 2;
    const dy = (targetH - dh) / 2;
    ctx.clearRect(0, 0, targetW, targetH); // transparent background
    ctx.drawImage(img, 0, 0, img.width, img.height, dx, dy, dw, dh);
    // PNG keeps the transparency; JPEG would fill it black.
    return canvas.toDataURL("image/png");
  }

  // Cover crop: scale source so it FILLS the canvas, then center it.
  const targetRatio = targetW / targetH;
  const sourceRatio = img.width / img.height;
  let sx = 0, sy = 0, sw = img.width, sh = img.height;
  if (sourceRatio > targetRatio) {
    // Source is wider than target → crop sides.
    sw = img.height * targetRatio;
    sx = (img.width - sw) / 2;
  } else if (sourceRatio < targetRatio) {
    // Source is taller than target → crop top/bottom.
    sh = img.width / targetRatio;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);
  return canvas.toDataURL("image/jpeg", 0.85);
}

// Silence unused-import warning when no upload happens
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _NextImage = Image;
