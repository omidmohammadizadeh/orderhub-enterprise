"use client";

// Phase AP — small banner at the top of the marketing landing page
// that recognises already-logged-in operators and points them at the
// dashboard so they don't have to detour through /login again. It's a
// pure client read of the auth store; no redirect — operator might
// genuinely want to see the marketing page even though they're logged
// in (e.g. to share a link with a colleague).

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useAuthStore } from "@/stores/auth.store";

export function LoggedInBanner() {
  const user = useAuthStore((s) => s.user);
  const isAuthed = useAuthStore((s) => s.isAuthenticated);
  if (!user || !isAuthed) return null;

  return (
    <div className="bg-emerald-50 border-b border-emerald-100">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2 text-xs">
        <p className="text-emerald-900">
          Signed in as <strong>{user.firstName ?? user.email}</strong>.
        </p>
        <Link
          href="/dashboard/orders"
          className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 font-semibold text-white hover:bg-emerald-700"
        >
          Go to dashboard <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}
