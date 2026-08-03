"use client";

// "Tell me when it's ready."
//
// Web Push on the storefront, which is the entire reason the PWA route beats
// waiting on App Store reviews: the customer taps once and their phone buzzes
// when the kitchen marks the order READY — no download, no install, no $99
// developer account per restaurant.
//
// The iOS caveat is real and is handled here rather than hidden: Safari only
// delivers push to a site that has been added to the home screen. Asking for
// permission before that happens throws, or silently does nothing, and the
// customer concludes the feature is broken. So on an iPhone that hasn't
// installed us yet we show the Share-sheet instructions instead of a button
// that cannot work.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Bell, BellRing, Share, Plus } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

const REF_KEY = "orderhub.groupRef";

/** Same browser-scoped ref the group-order flow uses, so one browser is one
 *  identity across features rather than accumulating a new uuid per feature. */
function deviceRef(): string {
  if (typeof window === "undefined") return "";
  let ref = window.localStorage.getItem(REF_KEY);
  if (!ref) {
    ref = crypto.randomUUID();
    try {
      window.localStorage.setItem(REF_KEY, ref);
    } catch {
      /* private window — in memory for this page only */
    }
  }
  return ref;
}

/** VAPID keys travel as base64url; PushManager wants raw bytes.
 *
 *  Backed by an explicit ArrayBuffer because applicationServerKey is typed as
 *  BufferSource, and a bare `new Uint8Array(n)` widens to ArrayBufferLike —
 *  which includes SharedArrayBuffer and so isn't assignable. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalised);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * navigator.serviceWorker.ready is a trap: with no worker registered it never
 * resolves AND never rejects, so an await on it hangs for the life of the
 * page. Untimed, that leaves this component stuck on "checking" (invisible) or
 * the button stuck on "Turning on…" forever. Registration is best-effort and
 * skipped entirely outside production, so this is a normal state, not an edge
 * case.
 */
async function readyWorker(ms = 4000): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("service worker not ready")), ms),
    ),
  ]);
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ reports as a Mac; the touch points give it away.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/** Installed to the home screen (or otherwise running outside a browser tab). */
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as any).standalone === true
  );
}

type State =
  | "checking"
  | "unsupported"
  | "needs-install" // iOS, not yet added to the home screen
  | "offer"
  | "working"
  | "on"
  | "denied"
  | "failed";

export function OrderNotifications({ orderId }: { orderId: string }) {
  const [state, setState] = useState<State>("checking");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // A browser with no push support at all — older Safari, some in-app
      // webviews. Render nothing rather than a button that throws.
      if (
        typeof window === "undefined" ||
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        !("Notification" in window)
      ) {
        // iOS below 16.4 lands here, and so does an iPhone in a browser tab:
        // installing is what unlocks it, so say so rather than giving up.
        if (!cancelled) setState(isIos() && !isStandalone() ? "needs-install" : "unsupported");
        return;
      }

      if (isIos() && !isStandalone()) {
        if (!cancelled) setState("needs-install");
        return;
      }

      if (Notification.permission === "denied") {
        if (!cancelled) setState("denied");
        return;
      }

      // Already subscribed on this browser? Then this order was covered at
      // subscribe time and there is nothing to ask for.
      try {
        const reg = await readyWorker();
        const existing = await reg.pushManager.getSubscription();
        if (existing && Notification.permission === "granted") {
          // Re-register against THIS order — the subscription is per browser,
          // the interest is per order, and someone ordering a second time
          // must not silently get nothing.
          await axios
            .post(`${API_BASE}/v1/customer-push/subscribe`, {
              orderId,
              endpoint: existing.endpoint,
              keys: existing.toJSON().keys,
              deviceRef: deviceRef(),
            })
            .catch(() => undefined);
          if (!cancelled) setState("on");
          return;
        }
      } catch {
        /* fall through to the offer */
      }

      // No VAPID key configured on this install → the feature is off. Don't
      // advertise a button that will fail.
      try {
        const { data } = await axios.get<{ key: string | null }>(
          `${API_BASE}/v1/customer-push/key`,
        );
        if (!cancelled) setState(data?.key ? "offer" : "unsupported");
      } catch {
        if (!cancelled) setState("unsupported");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [orderId]);

  const enable = useCallback(async () => {
    setState("working");
    try {
      const { data } = await axios.get<{ key: string | null }>(
        `${API_BASE}/v1/customer-push/key`,
      );
      if (!data?.key) {
        setState("unsupported");
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "offer");
        return;
      }

      const reg = await readyWorker();
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          // Required to be true by every browser — a push that shows nothing
          // is treated as abuse and can cost you the subscription.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(data.key),
        }));

      await axios.post(`${API_BASE}/v1/customer-push/subscribe`, {
        orderId,
        endpoint: sub.endpoint,
        keys: sub.toJSON().keys,
        deviceRef: deviceRef(),
      });
      setState("on");
    } catch {
      setState("failed");
    }
  }, [orderId]);

  if (state === "checking" || state === "unsupported") return null;

  if (state === "on") {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs text-emerald-800">
        <BellRing className="h-4 w-4 shrink-0" />
        <span>We&apos;ll notify you when your order status changes.</span>
      </div>
    );
  }

  if (state === "needs-install") {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white px-3 py-3 text-xs text-zinc-700">
        <p className="flex items-center gap-2 font-medium text-zinc-900">
          <Bell className="h-4 w-4 shrink-0" />
          Get order updates on your phone
        </p>
        <p className="mt-1.5 leading-relaxed text-zinc-600">
          On iPhone, add this page to your home screen first — tap
          <Share className="mx-1 inline h-3.5 w-3.5 align-text-bottom" />
          then <strong>Add to Home Screen</strong>
          <Plus className="mx-1 inline h-3.5 w-3.5 align-text-bottom" />, open it
          from there, and you&apos;ll be able to turn on notifications.
        </p>
      </div>
    );
  }

  if (state === "denied") {
    return (
      <p className="rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-xs text-zinc-500">
        Notifications are blocked for this site. You can re-enable them in your
        browser settings — this page keeps updating either way.
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-3 py-3">
      <p className="flex items-center gap-2 text-xs font-medium text-zinc-900">
        <Bell className="h-4 w-4 shrink-0" />
        Get notified when your order is ready
      </p>
      <button
        type="button"
        onClick={enable}
        disabled={state === "working"}
        className="mt-2 w-full rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {state === "working" ? "Turning on…" : "Turn on notifications"}
      </button>
      {state === "failed" && (
        <p className="mt-1.5 text-[11px] text-amber-600">
          Couldn&apos;t turn those on. This page still updates live.
        </p>
      )}
    </div>
  );
}
