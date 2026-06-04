// Phase AP marketing — floating WhatsApp chat bubble.
//
// Render's Docker build doesn't reliably pass NEXT_PUBLIC_* env vars
// into `next build`, which means anything we read via
// `process.env.NEXT_PUBLIC_X` from a "use client" file becomes the
// empty string in production. The bubble was hidden because the gate
// `if (!NUMBER) return null;` tripped on every render.
//
// Fix: drop "use client" entirely. This component is now a Server
// Component that reads the env var at render time (after `noStore()`
// opts out of route caching), so the value is picked up from Render's
// runtime env without any build-time inlining.
//
// Reads BOTH `WHATSAPP_NUMBER` (the new server-only var) and the
// legacy `NEXT_PUBLIC_WHATSAPP_NUMBER` so the operator's existing
// Render config still works without renaming.
//
// All animations are pure CSS. The 600ms entrance delay that used to
// live in a React useEffect now sits on `animation-delay` so the
// browser handles the staggering with zero JS.

import { unstable_noStore as noStore } from "next/cache";
import { MessageCircle } from "lucide-react";

const DEFAULT_MESSAGE = "Hi Order Hub — I'd like to know more.";

export function WhatsAppButton() {
  noStore();
  const raw =
    process.env.WHATSAPP_NUMBER ??
    process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ??
    "";
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return null;

  const href = `https://wa.me/${digits}?text=${encodeURIComponent(DEFAULT_MESSAGE)}`;

  return (
    <>
      <style>{`
        @keyframes wa-pop {
          0%   { transform: scale(0)   translateY(40px); opacity: 0; }
          60%  { transform: scale(1.1) translateY(-4px); opacity: 1; }
          100% { transform: scale(1)   translateY(0);    opacity: 1; }
        }
        @keyframes wa-pulse {
          0%,100% { box-shadow: 0 0 0 0 rgba(37,211,102,0.55); }
          50%     { box-shadow: 0 0 0 14px rgba(37,211,102,0); }
        }
        .wa-anim {
          animation:
            wa-pop 600ms cubic-bezier(0.34, 1.56, 0.64, 1) 600ms both,
            wa-pulse 2.4s ease-out infinite 1.8s;
        }
      `}</style>
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="Chat with us on WhatsApp"
        className="wa-anim fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full bg-[#25D366] px-4 py-3 font-semibold text-white shadow-2xl transition-transform hover:scale-105 sm:bottom-7 sm:right-7"
      >
        <MessageCircle className="h-5 w-5 fill-white" />
        <span className="hidden text-sm sm:inline">Chat with us</span>
      </a>
    </>
  );
}
