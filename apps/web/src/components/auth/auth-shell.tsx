// The dark, glowing card the sign-in screen sits in.
//
// Extracted so the password-reset pages are visibly the same product as the
// login page rather than a plain white form someone lands on from an email and
// has to squint at. Anything that follows a link out of an inbox should look
// unmistakably like where it came from — that is most of how a person decides
// a reset page isn't a phishing attempt.

import type { ReactNode } from "react";

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="auth-bg flex min-h-screen flex-col items-center justify-center p-4">
      {/* Subtle grid overlay */}
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.015]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,1) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />

      <div className="animate-fade-in relative w-full max-w-[420px]">
        {/* Glow */}
        <div className="pointer-events-none absolute -inset-px rounded-2xl bg-gradient-to-br from-orange-500/30 via-transparent to-violet-600/20 opacity-30 blur-xl" />

        <div className="shadow-auth relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white">
          <div className="h-1 w-full bg-gradient-to-r from-orange-400 via-orange-500 to-orange-600" />

          <div className="px-8 py-8">
            <div className="mb-8 flex flex-col items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-orange-400 to-orange-600 shadow-lg shadow-orange-500/30">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  className="h-6 w-6 text-white"
                  aria-hidden="true"
                >
                  <path
                    d="M3 7h18M3 12h18M3 17h10"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                  <circle cx="19" cy="17" r="3" fill="currentColor" opacity="0.8" />
                </svg>
              </div>
              <div className="text-center">
                <h1 className="text-xl font-bold tracking-tight text-zinc-900">
                  {title}
                </h1>
                {subtitle && (
                  <p className="mt-0.5 text-sm text-zinc-500">{subtitle}</p>
                )}
              </div>
            </div>

            {children}
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-zinc-500">
          © {new Date().getFullYear()} Order Hub Solutions. All rights reserved.
        </p>
      </div>
    </div>
  );
}
