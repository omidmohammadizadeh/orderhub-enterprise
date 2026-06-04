"use client";

// Phase AP marketing — floating WhatsApp chat bubble.
//
// Reads the support number from NEXT_PUBLIC_WHATSAPP_NUMBER (digits
// only — `447900123456`, no `+` or spaces). When unset we hide the
// bubble entirely instead of rendering a dead link.
//
// Tap → opens the standard wa.me deep link with a prefilled message.
// On desktop that opens WhatsApp Web; on mobile it opens the app
// directly.

import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";

const NUMBER = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? "";
const DEFAULT_MESSAGE = "Hi Order Hub — I'd like to know more.";

export function WhatsAppButton() {
  // Delay first paint a half-second so the bubble pops in AFTER the
  // hero loads — keeps it from competing with the hero CTA at first
  // glance.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setShown(true), 600);
    return () => window.clearTimeout(t);
  }, []);

  if (!NUMBER) return null;
  const href = `https://wa.me/${NUMBER.replace(/[^0-9]/g, "")}?text=${encodeURIComponent(DEFAULT_MESSAGE)}`;

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
        .wa-anim { animation: wa-pop 600ms cubic-bezier(0.34, 1.56, 0.64, 1) both, wa-pulse 2.4s ease-out infinite 1s; }
      `}</style>
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="Chat with us on WhatsApp"
        className={`fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full bg-[#25D366] px-4 py-3 font-semibold text-white shadow-2xl transition-transform hover:scale-105 sm:bottom-7 sm:right-7 ${
          shown ? "wa-anim" : "invisible"
        }`}
      >
        <MessageCircle className="h-5 w-5 fill-white" />
        <span className="hidden text-sm sm:inline">Chat with us</span>
      </a>
    </>
  );
}
