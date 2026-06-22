"use client";

// Phase AQ — audible alerts for the Orders board.
//
// Three sounds, all served from /sounds/ in the web app's public
// folder (apps/web/public/sounds/). Operator uploads the mp3s once
// and the dashboard plays them on the corresponding socket events.
//
//   • new-order.mp3       — every incoming order, regardless of platform
//   • cancelled-order.mp3 — order moves into CANCELLED / REJECTED / FAILED
//   • rider-arrived.mp3   — platform courier reaches the shop (RIDER_ARRIVED)
//
// We intentionally **do not** scope new-order or rider-arrived to a
// specific platform — front of house needs a single mental model
// ("an Uber order just came in", "a rider is at the counter") and
// platform-specific tones would just be noise. Cancellation likewise
// uses one neutral tone for all sources.
//
// Browser autoplay rules: audio.play() returns a Promise that rejects
// if the user hasn't interacted with the page yet. We swallow that
// rejection silently — the alert simply won't sound until the operator
// has clicked / tapped at least once, which they will the moment they
// touch any control on the board. Subsequent plays work without issue.
//
// Each Audio element is reused across plays to avoid construction
// overhead and to let us .pause() + .currentTime=0 mid-clip if two
// events fire in quick succession (e.g. three orders land in the
// same socket tick).

import { useEffect, useRef } from "react";

export type OrderSoundKind = "new" | "cancelled" | "rider_arrived";

// Filenames match what the operator uploaded to apps/web/public/sounds/
// — underscores, US spelling "canceled". If you re-upload with
// different names, update these paths to match.
const SOUND_PATHS: Record<OrderSoundKind, string> = {
  new: "/sounds/new_order.mp3",
  cancelled: "/sounds/canceled_order.mp3",
  rider_arrived: "/sounds/rider_arrived.mp3",
};

interface PlayOptions {
  /** Total number of plays. Defaults to 1 — i.e. play once. */
  repeatCount?: number;
  /** Gap between consecutive plays, in milliseconds. Defaults to 500. */
  intervalMs?: number;
}

interface UseOrderSoundsReturn {
  play: (kind: OrderSoundKind, opts?: PlayOptions) => void;
}

export function useOrderSounds(): UseOrderSoundsReturn {
  // Lazy-construct the Audio objects on first interaction so SSR is
  // happy (no `Audio is not defined` during the server render pass)
  // and so we don't hit the network for files the operator hasn't
  // uploaded yet (404s only fire on first .play()).
  const audioRefs = useRef<Partial<Record<OrderSoundKind, HTMLAudioElement>>>({});

  useEffect(() => {
    // Preload after mount so the first real event isn't delayed by a
    // round-trip to fetch the mp3. preload="auto" is the strongest
    // signal we can give the browser short of touching the buffer.
    (Object.keys(SOUND_PATHS) as OrderSoundKind[]).forEach((kind) => {
      if (audioRefs.current[kind]) return;
      const el = new Audio(SOUND_PATHS[kind]);
      el.preload = "auto";
      // Reasonable default — loud enough to hear above kitchen noise,
      // not loud enough to startle. Operators who want louder can
      // turn up system volume; we don't expose a per-sound slider.
      el.volume = 0.7;
      audioRefs.current[kind] = el;
    });
  }, []);

  const play = (kind: OrderSoundKind, opts?: PlayOptions) => {
    const el = audioRefs.current[kind];
    if (!el) return;
    // Clamp to sensible bounds — repeatCount of 0 or negative is
    // treated as 1, and we cap at 20 so a misconfigured rule can't
    // beep for 5 minutes.
    const total = Math.max(1, Math.min(20, opts?.repeatCount ?? 1));
    const interval = Math.max(200, opts?.intervalMs ?? 500);
    const playOnce = () => {
      try {
        el.pause();
        el.currentTime = 0;
        const result = el.play();
        if (result && typeof result.catch === "function") {
          result.catch(() => undefined);
        }
      } catch {
        // Older browsers throw synchronously.
      }
    };
    playOnce();
    if (total > 1) {
      let played = 1;
      const tick = () => {
        if (played >= total) return;
        played++;
        playOnce();
        if (played < total) setTimeout(tick, interval);
      };
      setTimeout(tick, interval);
    }
  };

  return { play };
}
