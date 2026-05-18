import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = { title: "Sign in — Order Hub Solutions" };

// The auth pages live in their own (auth) route group so they don't
// inherit the dashboard layout or protected route guards.
export default function LoginPage() {
  return (
    <div className="auth-bg min-h-screen flex flex-col items-center justify-center p-4">
      {/* Subtle grid overlay */}
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.015]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,1) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />

      {/* Card */}
      <div className="relative w-full max-w-[420px] animate-fade-in">
        {/* Glow */}
        <div className="pointer-events-none absolute -inset-px rounded-2xl opacity-30 blur-xl bg-gradient-to-br from-orange-500/30 via-transparent to-violet-600/20" />

        <div className="relative rounded-2xl border border-white/[0.08] bg-white shadow-auth overflow-hidden">
          {/* Top stripe */}
          <div className="h-1 w-full bg-gradient-to-r from-orange-400 via-orange-500 to-orange-600" />

          <div className="px-8 py-8">
            {/* Logo */}
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
                  Order Hub Solutions
                </h1>
                <p className="mt-0.5 text-sm text-zinc-500">
                  Sign in to your workspace
                </p>
              </div>
            </div>

            <LoginForm />
          </div>
        </div>

        {/* Footer */}
        <p className="mt-6 text-center text-xs text-zinc-500">
          © {new Date().getFullYear()} Order Hub Solutions. All rights reserved.
        </p>
      </div>
    </div>
  );
}
