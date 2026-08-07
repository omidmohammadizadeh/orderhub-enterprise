"use client";

// AI Video Studio — turn a product photo + description into a short marketing
// video (Replicate, behind the paid add-on). Phase 2 will replace the admin
// "activate/top-up" buttons with Stripe checkout.

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Clapperboard,
  Download,
  Loader2,
  Sparkles,
  Upload,
  AlertCircle,
} from "lucide-react";
import {
  videoStudioClient,
  type VideoGeneration,
} from "@/lib/api/video-studio.client";
import { uploadsClient } from "@/lib/api/catalog.client";

// Resize a picked image to at most `max` px on its long edge and return a
// JPEG data URL. Keeps upload/generation payloads small and consistent.
async function downscaleImage(file: File, max: number): Promise<string> {
  const readAsDataUrl = () =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("Couldn't read the image"));
      r.readAsDataURL(file);
    });
  const original = await readAsDataUrl();
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Couldn't decode the image"));
      el.src = original;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return original;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    // If canvas processing fails for any reason, use the original bytes.
    return original;
  }
}

export default function VideoStudioPage() {
  const qc = useQueryClient();

  const statusQuery = useQuery({
    queryKey: ["video-studio", "status"],
    queryFn: videoStudioClient.status,
  });
  const status = statusQuery.data;
  // Server decides who can use the temporary test-activation hooks (platform
  // admin, or a tenant owner when VIDEO_STUDIO_TEST_MODE is on).
  const canTest = status?.canTestActivate ?? false;

  const gensQuery = useQuery({
    queryKey: ["video-studio", "generations"],
    queryFn: videoStudioClient.list,
    // Poll while anything is still rendering.
    refetchInterval: (q) => {
      const data = q.state.data as VideoGeneration[] | undefined;
      const pending = data?.some(
        (g) => g.status === "RENDERING" || g.status === "QUEUED",
      );
      return pending ? 4000 : false;
    },
  });
  const generations = gensQuery.data ?? [];

  const [prompt, setPrompt] = useState("");
  const [script, setScript] = useState("");
  const [styleId, setStyleId] = useState("cinematic");
  const [format, setFormat] = useState("vertical");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const styles = status?.styles ?? [];
  const style = styles.find((s) => s.id === styleId) ?? styles[0];
  const cost = style?.credits ?? 1;

  const onPickFile = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      // Downscale to a compact JPEG data URL first — keeps the payload small
      // (phone photos are huge) and gives Replicate a clean image input.
      const dataUrl = await downscaleImage(file, 1024);
      // Prefer a hosted URL when image storage is configured. If it isn't
      // (Supabase not set up), fall back to the data URL — Replicate accepts a
      // data URI as the image input, so generation still works.
      try {
        const { publicUrl } = await uploadsClient.uploadProductImage({
          dataUrl,
          folder: "video-studio-src",
        });
        setImageUrl(publicUrl);
      } catch {
        setImageUrl(dataUrl);
      }
    } catch (e: any) {
      setError(e?.message ?? "Couldn't read the image");
    } finally {
      setUploading(false);
    }
  };

  const generate = useMutation({
    mutationFn: () =>
      videoStudioClient.generate({
        imageUrl: imageUrl || undefined,
        prompt: prompt.trim(),
        style: styleId,
        script: script.trim() || undefined,
        format,
      }),
    onSuccess: () => {
      setPrompt("");
      setScript("");
      setImageUrl(null);
      if (fileRef.current) fileRef.current.value = "";
      qc.invalidateQueries({ queryKey: ["video-studio"] });
    },
    onError: (e: any) =>
      setError(e?.response?.data?.message ?? e?.message ?? "Generation failed"),
  });

  const activate = useMutation({
    mutationFn: () => videoStudioClient.adminActivate(15),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["video-studio"] }),
  });
  const topup = useMutation({
    mutationFn: () => videoStudioClient.adminTopup(10),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["video-studio"] }),
  });
  const cancelGen = useMutation({
    mutationFn: (id: string) => videoStudioClient.cancel(id),
    // Refresh both the card list and the balance — cancelling refunds.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["video-studio"] }),
  });

  const isImage = style?.kind === "image";
  const canGenerate =
    (!!imageUrl || !!style?.imageOptional) &&
    prompt.trim().length > 3 &&
    (!style?.needsScript || script.trim().length > 3) &&
    (status?.balance ?? 0) >= cost &&
    !uploading;

  const balanceLabel = useMemo(() => {
    if (!status) return "";
    return `${status.balance} credit${status.balance === 1 ? "" : "s"} left`;
  }, [status]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-xl bg-violet-100 text-violet-700">
          <Clapperboard className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-zinc-900">AI Studio</h1>
          <p className="text-sm text-zinc-500">
            Generate marketing videos and photos from a product image or a prompt.
          </p>
        </div>
        {status?.addonActive && (
          <span className="ml-auto rounded-full bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-700">
            {balanceLabel}
          </span>
        )}
      </div>

      {/* Not subscribed → upsell */}
      {status && !status.addonActive && (
        <div className="mt-6 rounded-xl border border-violet-200 bg-violet-50/60 p-6 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-violet-600" />
          <h2 className="mt-2 text-lg font-semibold text-zinc-900">
            Unlock the AI Studio
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-600">
            Generate scroll-stopping product videos AND photos for your social
            posts and ads. Add it to your plan to get a monthly batch of
            credits, plus top-up packs whenever you need more.
          </p>
          {canTest ? (
            <button
              onClick={() => activate.mutate()}
              disabled={activate.isPending}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {activate.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Activate (test — grants 15 videos)
            </button>
          ) : (
            <button className="mt-4 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700">
              Add to my plan
            </button>
          )}
        </div>
      )}

      {/* Subscribed → generator */}
      {status?.addonActive && (
        <>
          {/* Ad style picker */}
          {styles.length > 1 && (
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {styles.map((s) => {
                const active = s.id === styleId;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setStyleId(s.id)}
                    className={`rounded-xl border p-4 text-left transition ${
                      active
                        ? "border-violet-500 bg-violet-50 ring-1 ring-violet-500"
                        : "border-zinc-200 bg-white hover:border-violet-300"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-zinc-900">
                        {s.label}
                      </span>
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
                        {s.credits} credit{s.credits === 1 ? "" : "s"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-zinc-500">
                      {s.kind === "image"
                        ? "A marketing photo from your prompt — upload a sample as a reference (optional)."
                        : s.audio
                          ? "A presenter speaks your script — with voice + sound."
                          : "Cinematic motion over your product photo (no audio)."}
                    </p>
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-4 grid gap-4 rounded-xl border border-zinc-200 bg-white p-5 sm:grid-cols-2">
            {/* Image */}
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-zinc-800">
                {isImage ? "Reference photo (optional)" : "Product photo"}
              </label>
              <div
                onClick={() => fileRef.current?.click()}
                className="flex aspect-square cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-zinc-300 bg-zinc-50 hover:border-violet-400"
              >
                {imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={imageUrl} alt="" className="h-full w-full object-contain" />
                ) : uploading ? (
                  <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
                ) : (
                  <div className="text-center text-sm text-zinc-400">
                    <Upload className="mx-auto h-6 w-6" />
                    <span>{isImage ? "Tap to add a sample" : "Tap to upload"}</span>
                  </div>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onPickFile(f);
                }}
              />
            </div>
            {/* Prompt + action */}
            <div className="flex flex-col">
              <label className="mb-1.5 block text-sm font-semibold text-zinc-800">
                {style?.needsScript
                  ? "Scene / setting"
                  : isImage
                    ? "Describe the photo"
                    : "Describe the video"}
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={style?.needsScript ? 3 : 5}
                placeholder={
                  style?.needsScript
                    ? "e.g. Bright modern takeaway counter, friendly young presenter holding the meal"
                    : isImage
                      ? "e.g. A gourmet pizza on a rustic wooden board, dramatic studio lighting, steam, dark moody background"
                      : "e.g. Cinematic advert of this pizza, steam rising, warm lighting, slow zoom"
                }
                className="w-full resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              />
              {style?.needsScript && (
                <>
                  <label className="mb-1.5 mt-3 block text-sm font-semibold text-zinc-800">
                    What should they say? (voiceover script)
                  </label>
                  <textarea
                    value={script}
                    onChange={(e) => setScript(e.target.value)}
                    rows={3}
                    placeholder="e.g. Craving a proper feast? Grab our Solo Meal — a juicy gyros wrap, golden fries and a cold drink. Order now!"
                    className="w-full resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                  />
                  <p className="mt-1 text-xs text-zinc-500">
                    Keep it short — about one or two sentences (~8 seconds of speech).
                  </p>
                </>
              )}
              {/* Format / aspect ratio */}
              <label className="mb-1.5 mt-3 block text-sm font-semibold text-zinc-800">
                Format
              </label>
              {style?.supportsFormat ? (
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: "vertical", label: "Vertical", ratio: "9:16", where: "TikTok · Reels" },
                    { id: "landscape", label: "Landscape", ratio: "16:9", where: "YouTube · FB" },
                    { id: "square", label: "Square", ratio: "1:1", where: "Feed" },
                  ].map((f) => {
                    const active = f.id === format;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setFormat(f.id)}
                        className={`rounded-lg border p-2 text-center transition ${
                          active
                            ? "border-violet-500 bg-violet-50 ring-1 ring-violet-500"
                            : "border-zinc-200 hover:border-violet-300"
                        }`}
                      >
                        <span className="block text-xs font-semibold text-zinc-800">
                          {f.label}
                        </span>
                        <span className="block text-[11px] text-zinc-500">{f.ratio}</span>
                        <span className="block text-[10px] text-zinc-400">{f.where}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-zinc-500">
                  This style follows your photo&apos;s shape — upload a tall photo for
                  a vertical clip, or a wide one for landscape.
                </p>
              )}
              <button
                onClick={() => generate.mutate()}
                disabled={!canGenerate || generate.isPending}
                className="mt-3 inline-flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
              >
                {generate.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                Generate {isImage ? "photo" : "video"} ({cost} credit{cost === 1 ? "" : "s"})
              </button>
              {(status.balance ?? 0) < cost && (
                <p className="mt-2 text-xs text-amber-700">
                  {(status.balance ?? 0) === 0
                    ? "You're out of credits — top up or wait for your monthly reset."
                    : `This style needs ${cost} credits — you have ${status.balance}. Top up or pick the cinematic style.`}
                </p>
              )}
              {canTest && (
                <button
                  onClick={() => topup.mutate()}
                  disabled={topup.isPending}
                  className="mt-2 text-xs font-medium text-violet-700 hover:underline"
                >
                  + Add 10 credits (test)
                </button>
              )}
            </div>
          </div>

          {error && (
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {/* Generations */}
          <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Your creations
          </h2>
          {generations.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-400">
              Nothing yet — generate your first one above.
            </p>
          ) : (
            <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {generations.map((g) => (
                <div
                  key={g.id}
                  className="overflow-hidden rounded-xl border border-zinc-200 bg-white"
                >
                  <div className="aspect-square bg-zinc-900">
                    {g.status === "READY" && g.resultUrl ? (
                      g.kind === "IMAGE" ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={g.resultUrl}
                          alt={g.prompt}
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <VideoTile url={g.resultUrl} />
                      )
                    ) : g.status === "FAILED" ? (
                      <div className="flex h-full flex-col items-center justify-center gap-1 p-3 text-center text-xs text-red-300">
                        <AlertCircle className="h-5 w-5" />
                        Failed — credit refunded
                        {g.error && <span className="text-red-400/80">{g.error}</span>}
                      </div>
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-400">
                        <Loader2 className="h-6 w-6 animate-spin" />
                        <span className="text-xs">Rendering…</span>
                        {/* A render that can't finish would otherwise spin
                            here forever, holding the credit with it. */}
                        <button
                          type="button"
                          onClick={() => cancelGen.mutate(g.id)}
                          disabled={cancelGen.isPending}
                          className="mt-1 rounded-md border border-zinc-600 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
                        >
                          Cancel & refund
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 p-3">
                    <p className="line-clamp-2 text-xs text-zinc-600">{g.prompt}</p>
                    {g.status === "READY" && g.resultUrl && (
                      <a
                        href={g.resultUrl}
                        download
                        className="shrink-0 rounded-md p-1.5 text-violet-700 hover:bg-violet-50"
                        title="Download"
                      >
                        <Download className="h-4 w-4" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}


/**
 * One finished video.
 *
 * playsInline matters: without it iOS hijacks the tap into a fullscreen
 * player, which on a dashboard reads as the tile refusing to play in place.
 *
 * The error state matters more. A dead URL previously rendered a black box
 * with controls that did nothing — indistinguishable from a broken feature,
 * and impossible to report usefully. Now it says so, and still offers the
 * link so the file can be checked directly.
 */
function VideoTile({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <AlertCircle className="h-5 w-5 text-amber-400" />
        <p className="text-xs text-zinc-300">This video couldn&apos;t be loaded.</p>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] font-semibold text-orange-400 underline"
        >
          Open it directly
        </a>
      </div>
    );
  }

  return (
    <video
      src={url}
      controls
      playsInline
      preload="metadata"
      onError={() => setFailed(true)}
      className="h-full w-full object-contain"
    />
  );
}
