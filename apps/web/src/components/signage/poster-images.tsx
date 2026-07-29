"use client";

// Digital Signage — poster / promo artwork for a screen.
//
// A screen can show the live menu (the original behaviour), a slideshow of
// uploaded images, or alternate between them. Operators use this for offers,
// opening hours, "we now deliver" cards — anything that isn't a menu.
//
// Images go to the same Supabase Storage bucket product photos use, and the
// screen stores the resulting https URLs in its config. Nothing is stored as
// a data URL: a 4K poster inlined into config JSON would bloat every board
// poll on the TV, so an upload that can't reach storage is reported as a
// failure rather than silently falling back.

import { useRef, useState } from "react";
import toast from "react-hot-toast";
import { ArrowLeft, ArrowRight, ImagePlus, Loader2, Trash2 } from "lucide-react";
import { uploadsClient } from "@/lib/api/catalog.client";
import type { SignageConfig } from "@/lib/api/signage.client";

// TVs are 1080p or 4K; anything wider than 2560 is wasted bytes on a screen
// that polls over the shop's wifi.
const MAX_EDGE = 2560;
const MAX_FILE_MB = 12;

/**
 * Downscale to a sane edge and re-encode. PNG screenshots of posters are
 * routinely 8–20MB; JPEG at 0.9 gets the same poster under a megabyte with
 * no visible loss at TV viewing distance. PNGs with transparency keep it —
 * re-encoding those to JPEG would fill the transparent areas black.
 */
async function toUploadableDataUrl(file: File): Promise<string> {
  const isPng = file.type === "image/png";
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't read that image");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  return isPng
    ? canvas.toDataURL("image/png")
    : canvas.toDataURL("image/jpeg", 0.9);
}

export function PosterImages({
  config,
  onChange,
}: {
  config: SignageConfig;
  onChange: (next: Partial<SignageConfig>) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const images = config.images ?? [];
  const mode = config.mode ?? "MENU";

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    const added: string[] = [];
    try {
      for (const file of Array.from(files)) {
        if (!/^image\/(png|jpeg|jpg)$/.test(file.type)) {
          toast.error(`${file.name} isn't a PNG or JPEG`);
          continue;
        }
        if (file.size > MAX_FILE_MB * 1024 * 1024) {
          toast.error(`${file.name} is over ${MAX_FILE_MB}MB`);
          continue;
        }
        const dataUrl = await toUploadableDataUrl(file);
        const { publicUrl } = await uploadsClient.uploadProductImage({
          dataUrl,
          folder: "signage",
        });
        added.push(publicUrl);
      }
      if (added.length) {
        // Turning MENU into MIXED on the first upload is the behaviour
        // operators expect: they added a poster, so they want to see it.
        // Anyone who wants posters only can switch to Images below.
        onChange({
          images: [...images, ...added],
          ...(mode === "MENU" ? { mode: "MIXED" as const } : {}),
        });
        toast.success(added.length === 1 ? "Image added" : `${added.length} images added`);
      }
    } catch (e: any) {
      toast.error(
        e?.response?.data?.message ??
          e?.message ??
          "Couldn't upload that image",
      );
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const move = (i: number, dir: -1 | 1) => {
    const next = [...images];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange({ images: next });
  };

  const remove = (i: number) =>
    onChange({ images: images.filter((_, n) => n !== i) });

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-sm font-medium text-zinc-700">
          What this screen shows
        </label>
        <div className="flex gap-1.5">
          {(
            [
              ["MENU", "Menu only"],
              ["MIXED", "Menu + images"],
              ["IMAGES", "Images only"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => onChange({ mode: value })}
              className={
                mode === value
                  ? "flex-1 rounded-md bg-zinc-900 px-2 py-2 text-xs font-semibold text-white"
                  : "flex-1 rounded-md border border-zinc-200 px-2 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              }
            >
              {label}
            </button>
          ))}
        </div>
        {mode !== "MENU" && !images.length && (
          <p className="mt-1 text-[11px] text-amber-600">
            Add at least one image below, or the screen keeps showing the menu.
          </p>
        )}
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-zinc-700">
          Images ({images.length})
        </label>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          multiple
          className="hidden"
          onChange={(e) => void addFiles(e.target.files)}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-zinc-300 px-3 py-4 text-sm font-medium text-zinc-600 hover:border-zinc-400 hover:bg-zinc-50 disabled:opacity-50"
        >
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Uploading…
            </>
          ) : (
            <>
              <ImagePlus className="h-4 w-4" /> Upload PNG or JPEG
            </>
          )}
        </button>

        {!!images.length && (
          <ul className="mt-2 space-y-1.5">
            {images.map((url, i) => (
              <li
                key={`${url}-${i}`}
                className="flex items-center gap-2 rounded-md border border-zinc-200 p-1.5"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt=""
                  className="h-12 w-20 shrink-0 rounded bg-zinc-100 object-contain"
                />
                <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-400">
                  {url.split("/").pop()}
                </span>
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label="Move earlier"
                  className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 disabled:opacity-30"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === images.length - 1}
                  aria-label="Move later"
                  className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 disabled:opacity-30"
                >
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  aria-label="Remove"
                  className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {mode !== "MENU" && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700">
              Seconds per image
            </label>
            <input
              type="number"
              min={2}
              max={300}
              value={config.imageSeconds ?? 10}
              onChange={(e) =>
                onChange({ imageSeconds: Number(e.target.value) || 10 })
              }
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
            />
          </div>
          {mode === "MIXED" && (
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">
                Seconds on the menu
              </label>
              <input
                type="number"
                min={2}
                max={600}
                value={config.menuSeconds ?? 20}
                onChange={(e) =>
                  onChange({ menuSeconds: Number(e.target.value) || 20 })
                }
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
              />
            </div>
          )}
          <div className={mode === "MIXED" ? "col-span-2" : ""}>
            <label className="mb-1 block text-sm font-medium text-zinc-700">
              How images fill the screen
            </label>
            <select
              value={config.imageFit ?? "contain"}
              onChange={(e) =>
                onChange({ imageFit: e.target.value as "contain" | "cover" })
              }
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
            >
              <option value="contain">Fit — show the whole image</option>
              <option value="cover">Fill — cover the screen, may crop</option>
            </select>
            <p className="mt-1 text-[11px] text-zinc-400">
              Use Fit for posters with text near the edges.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
