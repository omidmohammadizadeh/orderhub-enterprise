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
  Clapperboard as FilmIcon,
} from "lucide-react";
import {
  videoStudioClient,
  type StorageCheck,
  type VideoGeneration,
} from "@/lib/api/video-studio.client";
import { uploadsClient } from "@/lib/api/catalog.client";

// Mirrors the server's limit — the API rejects a longer script outright, so
// the page should say so before the button is pressed rather than after.
const MAX_SCRIPT_SECONDS = 8;
const MAX_SCRIPT_WORDS = Math.floor(MAX_SCRIPT_SECONDS * 2.75);
import { useSelectedLocationStore } from "@/stores/selected-location.store";

// Resize a picked image to at most `max` px on its long edge and return a
// JPEG data URL. Keeps upload/generation payloads small and consistent.
/**
 * Grab the final frame of a finished video as a JPEG data URL.
 *
 * Seeks slightly BEFORE the end: seeking to exactly `duration` lands past the
 * last decoded frame in most browsers and paints black. Needs the video to be
 * served with CORS, or the canvas is tainted and toDataURL throws — which is
 * why the caller offers "download it and upload a still" as the way out.
 */
async function lastFrameOf(url: string): Promise<string> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error("Couldn't load that video to read its last frame."));
  });
  await new Promise<void>((resolve) => {
    video.onseeked = () => resolve();
    video.currentTime = Math.max(0, (video.duration || 0.2) - 0.15);
  });
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx || !canvas.width) throw new Error("Couldn't read that video's last frame.");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  try {
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    throw new Error(
      "That video can't be read directly. Download it and upload the last frame as a photo.",
    );
  }
}

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

  // Renders are billed to the SELECTED location's wallet, so the balance and
  // prices shown have to follow it — and the location is part of the cache key
  // or you'd be quoted one site's prices while another site paid.
  const locationId = useSelectedLocationStore((st) => st.selectedLocationId);
  const statusQuery = useQuery({
    queryKey: ["video-studio", "status", locationId],
    queryFn: () => videoStudioClient.status(locationId),
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
  const priceOf = (id?: string) => (id ? (status?.pricesMinor?.[id] ?? 0) : 0);
  const cost = priceOf(style?.id);
  // ~2.75 words a second is natural ad delivery; 8s is Veo's ceiling.
  const scriptWords = script.trim().split(/\s+/).filter(Boolean).length;
  const spokenSeconds = scriptWords / 2.75;
  const tooLong = spokenSeconds > MAX_SCRIPT_SECONDS;
  // The clip we'll actually ask for — 4, 6 or 8. Shorter costs us less and
  // the customer pays the same, so there's no reason to buy silence.
  const clipSeconds = [4, 6, 8].find((d) => spokenSeconds <= d) ?? 8;
  const money = (minor: number) =>
    new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: status?.currency || "GBP",
    }).format(minor / 100);

  // Adopt a source image: hosted when storage is on, data URL when it isn't.
  const useSource = async (dataUrl: string) => {
    try {
      const { publicUrl } = await uploadsClient.uploadProductImage({
        dataUrl,
        folder: "video-studio-src",
      });
      setImageUrl(publicUrl);
    } catch {
      setImageUrl(dataUrl);
    }
  };

  // Continue a scene: the last frame of a finished video becomes the first
  // frame of the next one. That is what actually keeps the same presenter,
  // shop and lighting — Veo 3.1 Lite can't take reference images, and asking
  // the prompt to "use the same man" does not hold a face.
  const continueFrom = async (g: VideoGeneration) => {
    if (!g.resultUrl) return;
    setError(null);
    setUploading(true);
    try {
      const frame = await lastFrameOf(g.resultUrl);
      await useSource(frame);
      setStyleId(g.kind === "IMAGE" ? styleId : "spokesperson");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e: any) {
      setError(
        e?.message ??
          "Couldn't read the last frame of that video. Download it and upload a still instead.",
      );
    } finally {
      setUploading(false);
    }
  };

  const onPickFile = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      // Downscale to a compact JPEG data URL first — keeps the payload small
      // (phone photos are huge) and gives Replicate a clean image input.
      const dataUrl = await downscaleImage(file, 1024);
      // Prefer a hosted URL when image storage is configured; the data URL
      // still works as a model input when it isn't.
      await useSource(dataUrl);
    } catch (e: any) {
      setError(e?.message ?? "Couldn't read the image");
    } finally {
      setUploading(false);
    }
  };

  const generate = useMutation({
    mutationFn: () =>
      videoStudioClient.generate({
        locationId: locationId ?? undefined,
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
  const cancelGen = useMutation({
    mutationFn: (id: string) => videoStudioClient.cancel(id),
    // Refresh both the card list and the balance — cancelling refunds.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["video-studio"] }),
  });

  const isImage = style?.kind === "image";
  const canGenerate =
    (!!imageUrl || !!style?.imageOptional) &&
    prompt.trim().length > 3 &&
    (!style?.needsScript || (script.trim().length > 3 && !tooLong)) &&
    (status?.balanceMinor ?? 0) >= cost &&
    !uploading;

  const balanceLabel = useMemo(() => {
    if (!status) return "";
    return `${money(status.balanceMinor ?? 0)} wallet balance`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            posts and ads. Pay per video from the same wallet your texts and
            AI calls already use — no separate credits to keep track of.
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
                        {money(priceOf(s.id))}
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
                  {/* Veo never speaks faster to fit a long line — it stops
                      when the clip ends, mid-word. So this is a limit, not a
                      style note, and it has to be visible while typing. */}
                  <p
                    className={
                      "mt-1 text-xs " + (tooLong ? "font-medium text-amber-700" : "text-zinc-500")
                    }
                  >
                    {scriptWords === 0
                      ? "Keep it to one or two sentences — about 22 words fits the 8 seconds."
                      : tooLong
                        ? `≈${spokenSeconds.toFixed(1)}s of speech — too long for an 8s video, the end would be cut off. Trim to about ${MAX_SCRIPT_WORDS} words (${scriptWords} now).`
                        : `≈${spokenSeconds.toFixed(1)}s of speech · ${scriptWords} word${scriptWords === 1 ? "" : "s"} — fits an ${clipSeconds}s video.`}
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
                Generate {isImage ? "photo" : "video"} ({money(cost)})
              </button>
              {(status.balanceMinor ?? 0) < cost && (
                <p className="mt-2 text-xs text-amber-700">
                  This costs {money(cost)} and this location&apos;s wallet has{" "}
                  {money(status.balanceMinor ?? 0)}.{" "}
                  <a href="/dashboard/wallet" className="font-semibold underline">
                    Top up the wallet
                  </a>{" "}
                  — the same balance your texts and AI calls use.
                </p>
              )}
            </div>
          </div>

          {error && (
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {status?.providers && (
            <p className="mt-4 text-xs text-zinc-500">
              Renderer:{" "}
              <strong className="text-zinc-800">
                {status.providers.gemini
                  ? "Google Veo (AI Studio)"
                  : "Replicate"}
              </strong>
              {!status.providers.gemini && (
                <>
                  {" — "}
                  Google isn&apos;t connected, so styles that ask for Veo fall
                  back to Replicate. Set GEMINI_API_KEY to use Google.
                </>
              )}
            </p>
          )}

          <StorageDiagnostic />

          {!status?.storageReady && (
            <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <strong>Videos won&apos;t stay playable.</strong> File storage
              isn&apos;t configured, so finished videos keep a link from the AI
              provider that expires within the hour. Set the Supabase storage
              variables on the API service to fix it.
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
                        Failed — refunded to your wallet
                        {g.error && <span className="text-red-400/80">{g.error}</span>}
                      </div>
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-400">
                        <Loader2 className="h-6 w-6 animate-spin" />
                        <span className="text-xs">Rendering…</span>
                        {/* A render that can't finish would otherwise spin
                            here forever, holding the money with it. */}
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
                      <div className="flex shrink-0 items-center gap-0.5">
                        {g.kind !== "IMAGE" && (
                          <button
                            type="button"
                            onClick={() => continueFrom(g)}
                            disabled={uploading}
                            className="rounded-md p-1.5 text-violet-700 hover:bg-violet-50 disabled:opacity-50"
                            title="Continue this scene — same presenter and setting"
                          >
                            <FilmIcon className="h-4 w-4" />
                          </button>
                        )}
                        <a
                          href={g.resultUrl}
                          download
                          className="rounded-md p-1.5 text-violet-700 hover:bg-violet-50"
                          title="Download"
                        >
                          <Download className="h-4 w-4" />
                        </a>
                      </div>
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


/**
 * One button that answers "why did my video disappear".
 *
 * Every failure in the re-hosting path surfaces to the operator as a dead
 * video with no cause attached, and the cause is almost always a bucket
 * setting only Supabase can report. Working that out from the outside cost
 * several rounds of guessing; this asks directly.
 */
function StorageDiagnostic() {
  const [result, setResult] = useState<StorageCheck | null>(null);
  const check = useMutation({
    mutationFn: () => videoStudioClient.storageCheck(),
    onSuccess: setResult,
  });

  return (
    <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => check.mutate()}
          disabled={check.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:border-zinc-300 disabled:opacity-50"
        >
          {check.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Check file storage
        </button>
        <span className="text-[11px] text-zinc-500">
          Run this if a finished video won&apos;t play — it reports whether we
          can actually save one.
        </span>
      </div>

      {result && (
        <div className="mt-3 space-y-1.5 text-xs">
          <p className="text-zinc-600">
            Bucket: <code className="text-zinc-900">{result.bucket}</code>
          </p>
          <p className={result.video.ok ? "text-emerald-700" : "text-red-700"}>
            {result.video.ok ? "✓" : "✕"} Video (mp4)
            {result.video.error ? ` — ${result.video.error}` : ""}
          </p>
          <p className={result.image.ok ? "text-emerald-700" : "text-red-700"}>
            {result.image.ok ? "✓" : "✕"} Image (png)
            {result.image.error ? ` — ${result.image.error}` : ""}
          </p>
          {result.likelyCause && (
            <p className="rounded bg-amber-50 p-2 text-amber-900">
              {result.likelyCause}
            </p>
          )}
        </div>
      )}
      {check.isError && (
        <p className="mt-2 text-xs text-red-600">
          Couldn&apos;t run the check.
        </p>
      )}
    </div>
  );
}
