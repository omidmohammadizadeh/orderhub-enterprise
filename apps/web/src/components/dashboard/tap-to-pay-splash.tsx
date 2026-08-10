"use client";

// Tap to Pay on iPhone announcement — Apple's App Review checklist rows 3.1,
// 3.2 and 6.2.
//
// Apple requires a full-screen modal ("Hero" banner in their Marketing
// Toolkit) shown at least once to every eligible user, so an EXISTING
// merchant discovers the feature rather than having to stumble on it. It's
// also what the "Existing User Flow" review video has to demonstrate.
//
// Copy is taken VERBATIM from Apple's UK copy guide
// (GBEN_Digital_Q126_Tap_to_Pay_on_iPhone_Copy.docx) — headline, subheadline,
// "Short copy" block and CTA are all theirs, with only the bracketed partner
// placeholders filled in. This is not copy we may rewrite for tone.
//
// The legal block is the reason this component looks text-heavy. Apple's
// guide: "The following disclaimers must be used across all advertising. In
// placements where space is limited, the short disclaimer can be used but
// must click through to your Tap to Pay on iPhone product page where the
// full disclaimer is displayed." We have no such product page, so the SHORT
// form ("Terms apply.") is not available to us and the FULL disclaimer has
// to appear inline.
//
// The Apple Pay paragraph is a SECOND, additional disclaimer that Apple
// requires whenever the communication mentions Apple Pay — which this one
// does, in the approved body copy. Dropping either is a compliance failure,
// not a tidy-up.
//
// Naming rule that must survive any edit: always the full "Tap to Pay on
// iPhone", never "Tap to Pay" alone and never "Apple Tap to Pay".
//
// Eligibility, so a restaurant on a desktop or an Android tablet is never
// shown an iPhone-only feature:
//   • running inside the native app (window.OrderHubTerminal.isReady), and
//   • the device passes the Tap to Pay OS/hardware check, and
//   • the user's role can actually reach Card Readers and enable it, and
//   • this user hasn't already seen it.
//
// That role gate matters twice over: a KIOSK account drives a CUSTOMER-facing
// screen, so a merchant advert must never appear on it; and pointing a
// cashier at a page their role can't open would be a dead end, not an
// eligible user.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { useAuthStore } from "@/stores/auth.store";

const SEEN_KEY_PREFIX = "oh:ttp:announced:";

// Mirrors the roles allowed on /dashboard/card-readers (see sidebar.tsx) —
// the CTA has to land somewhere the user can actually use.
const CAN_ENABLE_ROLES = new Set([
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "DARK_KITCHEN_MANAGER",
  "MANAGER",
]);

export function TapToPaySplash() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    if (!CAN_ENABLE_ROLES.has(String(user.role))) return;
    const oh = (
      window as {
        OrderHubTerminal?: { isReady?: boolean; tapToPaySupported?: boolean };
      }
    ).OrderHubTerminal;
    // Native app + Tap to Pay-capable device only.
    if (oh?.isReady !== true || oh?.tapToPaySupported !== true) return;
    // Per USER, not per device: a shared shop tablet has several staff logins
    // and Apple wants every eligible user to see it at least once.
    try {
      if (localStorage.getItem(SEEN_KEY_PREFIX + user.id)) return;
    } catch {
      // Private mode / storage disabled — showing it again is the safe
      // failure, missing it entirely is not.
    }
    setShow(true);
  }, [user?.id]);

  const dismiss = () => {
    try {
      if (user?.id) localStorage.setItem(SEEN_KEY_PREFIX + user.id, "1");
    } catch {
      /* see above */
    }
    setShow(false);
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-zinc-900/70 p-4">
      <div className="relative w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl">
        <button
          onClick={dismiss}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 rounded-full bg-white/80 p-1 text-zinc-500 hover:text-zinc-800"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="bg-gradient-to-b from-violet-600 to-violet-700 px-6 pb-8 pt-10 text-center text-white">
          {/* Deliberately no contactless glyph here: Apple only permits their
              own wave.3.right.circle SF Symbol on Tap to Pay UI, and a web
              page can't render it. Type-only avoids a non-conforming mark. */}
          <h2 className="text-2xl font-bold leading-tight tracking-tight">
            Tap to Pay on iPhone
          </h2>
        </div>

        <div className="space-y-4 p-6">
          <p className="text-sm font-medium text-zinc-900">
            Accept contactless payments on your iPhone.
          </p>
          <p className="text-sm leading-relaxed text-zinc-600">
            With Tap to Pay on iPhone and OrderHub, you can accept all types of
            in-person, contactless payments on your iPhone — from physical debit
            and credit cards to Apple Pay and other digital wallets. No extra
            readers or hardware needed. It&rsquo;s easy, secure and private.
          </p>

          <button
            onClick={() => {
              dismiss();
              router.push("/dashboard/card-readers");
            }}
            className="w-full rounded-lg bg-zinc-900 px-4 py-3 text-sm font-semibold text-white hover:bg-zinc-800"
          >
            Enable now
          </button>
          <button
            onClick={dismiss}
            className="w-full text-center text-sm font-medium text-zinc-500 hover:text-zinc-700"
          >
            Not now
          </button>

          {/* Apple's FULL disclaimer, verbatim. The short "Terms apply."
              form is only permitted where it click-throughs to a product page
              carrying this text, which we don't have. */}
          <div className="max-h-32 space-y-2 overflow-y-auto rounded-md bg-zinc-50 p-2.5 text-[10px] leading-relaxed text-zinc-500">
            <p>
              Tap to Pay on iPhone Requirements: Tap to Pay on iPhone requires a
              supported payment app and the latest version of iOS. Update to the
              latest version by going to Settings &gt; General &gt; Software
              Update. Tap Download and Install. Some contactless cards may not be
              accepted by your payment app. Transaction limits may apply. The
              Contactless Symbol is a trademark owned by and used with permission
              of EMVCo, LLC. Tap to Pay on iPhone is not available in all
              markets. For Tap to Pay on iPhone countries and regions, see{" "}
              <a
                href="https://developer.apple.com/tap-to-pay/regions"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                developer.apple.com/tap-to-pay/regions
              </a>
              .
            </p>
            {/* Required IN ADDITION whenever the copy mentions Apple Pay. */}
            <p>
              Apple Pay is a service provided by Apple Payments Services LLC, a
              subsidiary of Apple Inc. Neither Apple Inc. nor Apple Payments
              Services LLC is a bank. Any card used in Apple Pay is offered by
              the card issuer.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
