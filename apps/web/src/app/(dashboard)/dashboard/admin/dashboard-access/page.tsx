"use client";

// Admin Dashboard → Dashboard access.
//
// Route shell only. The screen itself is a component so it can be rendered
// (and looked at) outside the authenticated dashboard shell — and because a
// named export from a page.tsx is an App Router build error waiting to
// happen.

import { Lock } from "lucide-react";
import { useAuthStore } from "@/stores/auth.store";
import { DashboardAccessPanel } from "@/components/admin/dashboard-access-panel";

export default function DashboardAccessPage() {
  const user = useAuthStore((s) => s.user);

  if (user && user.role !== "PLATFORM_ADMIN") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Lock className="mb-3 h-10 w-10 text-zinc-300" aria-hidden="true" />
        <p className="font-medium text-zinc-500">Admin only</p>
        <p className="mt-1 text-sm text-zinc-400">
          Only the platform team can change what a location sees.
        </p>
      </div>
    );
  }

  return <DashboardAccessPanel />;
}
