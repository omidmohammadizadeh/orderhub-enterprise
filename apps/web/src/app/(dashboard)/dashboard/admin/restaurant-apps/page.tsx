"use client";

// Admin Dashboard → Restaurant apps.
//
// Route shell only — the screen is a component, because a named export from a
// page.tsx is an App Router build error waiting to happen.

import { Lock } from "lucide-react";
import { useAuthStore } from "@/stores/auth.store";
import { RestaurantAppsPanel } from "@/components/admin/restaurant-apps-panel";

export default function RestaurantAppsPage() {
  const user = useAuthStore((s) => s.user);

  if (user && user.role !== "PLATFORM_ADMIN") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Lock className="mb-3 h-10 w-10 text-zinc-300" aria-hidden="true" />
        <p className="font-medium text-zinc-500">Admin only</p>
        <p className="mt-1 text-sm text-zinc-400">Only the platform team manages the restaurant apps.</p>
      </div>
    );
  }

  return <RestaurantAppsPanel />;
}
