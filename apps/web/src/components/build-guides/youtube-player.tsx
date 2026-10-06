"use client";

// Click-to-play YouTube for "How to build" videos. Only a thumbnail loads
// until someone taps it — a screen full of guides never pulls in a dozen
// players. Playback is a privacy-enhanced embed straight from YouTube to
// the device; nothing goes through our API and no YouTube API key is used.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Play, X } from "lucide-react";
import { formatVideoTime, parseYouTubeId, youTubeEmbedUrl, youTubeThumbnail } from "@orderhub/shared";
import { cn } from "@/lib/utils";

export function YouTubePlayer({
  videoUrl,
  start,
  className,
  autoPlay = false,
}: {
  videoUrl: string;
  start?: number | null;
  className?: string;
  /** Start playing immediately (only after a tap opened it — browsers block unprompted sound) */
  autoPlay?: boolean;
}) {
  const id = parseYouTubeId(videoUrl);
  const [playing, setPlaying] = useState(autoPlay);
  useEffect(() => setPlaying(autoPlay), [videoUrl, start, autoPlay]);
  if (!id) return null;

  return (
    <div className={cn("relative aspect-video w-full overflow-hidden rounded-xl bg-black", className)}>
      {playing ? (
        <iframe
          key={`${id}-${start ?? 0}`}
          src={youTubeEmbedUrl(id, { start, autoplay: true })}
          title="How to build video"
          className="absolute inset-0 h-full w-full"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          className="group absolute inset-0 h-full w-full"
          aria-label="Play video"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={youTubeThumbnail(id)} alt="" className="h-full w-full object-cover opacity-90" />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex items-center gap-2 rounded-full bg-red-600 px-5 py-3 text-base font-bold text-white shadow-lg group-hover:bg-red-500">
              <Play className="h-5 w-5 fill-white" />
              {start ? `Play from ${formatVideoTime(start)}` : "Play video"}
            </span>
          </span>
        </button>
      )}
    </div>
  );
}

/** Full-screen player on top of everything (training walkthrough). */
export function VideoOverlay({
  videoUrl,
  start,
  title,
  onClose,
}: {
  videoUrl: string;
  start?: number | null;
  title?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[90] flex flex-col bg-black/95 p-3 sm:p-6" onClick={onClose}>
      <div className="mb-3 flex items-center justify-between text-white">
        <p className="truncate text-sm font-semibold">
          {title}
          {start ? ` · from ${formatVideoTime(start)}` : ""}
        </p>
        <button onClick={onClose} className="rounded-lg p-2 hover:bg-white/10" aria-label="Close video">
          <X className="h-6 w-6" />
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center" onClick={(e) => e.stopPropagation()}>
        <YouTubePlayer videoUrl={videoUrl} start={start} autoPlay className="max-h-full max-w-[min(100%,calc((100vh-6rem)*16/9))]" />
      </div>
    </div>,
    document.body,
  );
}
