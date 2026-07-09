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
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
      videoStudioClient.generate({ imageUrl: imageUrl!, prompt: prompt.trim() }),
    onSuccess: () => {
      setPrompt("");
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

  const canGenerate =
    !!imageUrl && prompt.trim().length > 3 && (status?.balance ?? 0) > 0 && !uploading;

  const balanceLabel = useMemo(() => {
    if (!status) return "";
    return `${status.balance} video${status.balance === 1 ? "" : "s"} left`;
  }, [status]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-xl bg-violet-100 text-violet-700">
          <Clapperboard className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-zinc-900">AI Video Studio</h1>
          <p className="text-sm text-zinc-500">
            Turn a product photo into a short marketing video.
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
            Unlock the AI Video Studio
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-600">
            Generate scroll-stopping product videos for your social posts and
            ads. Add it to your plan to get a monthly batch of videos, plus
            top-up packs whenever you need more.
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
          <div className="mt-6 grid gap-4 rounded-xl border border-zinc-200 bg-white p-5 sm:grid-cols-2">
            {/* Image */}
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-zinc-800">
                Product photo
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
                    <span>Tap to upload</span>
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
                Describe the video
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={5}
                placeholder="e.g. Cinematic advert of this pizza, steam rising, warm lighting, slow zoom"
                className="w-full flex-1 resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              />
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
                Generate video (1 credit)
              </button>
              {(status.balance ?? 0) === 0 && (
                <p className="mt-2 text-xs text-amber-700">
                  You're out of credits — top up or wait for your monthly reset.
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
            Your videos
          </h2>
          {generations.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-400">
              No videos yet — generate your first one above.
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
                      <video
                        src={g.resultUrl}
                        controls
                        className="h-full w-full object-contain"
                      />
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
