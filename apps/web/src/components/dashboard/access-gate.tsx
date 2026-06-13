"use client";

// Phase AR — sits between AuthGuard and the dashboard chrome. Looks
// at the user's role and their location assignments, and decides
// whether to show the sidebar/page (normal flow) or the no-access
// screen (freshly created account, nobody has assigned them yet).
//
// Tenant-wide roles (PLATFORM_ADMIN, TENANT_OWNER) and platform-
// staff roles (ONBOARDING_AGENT, FINANCIAL_AGENT) bypass the check
// because their job doesn't require location assignment — admins
// manage the platform, onboarding agents create new tenants,
// billing agents handle subscriptions. Everyone else needs at least
// one UserLocation row before they can do anything useful.

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { locationsClient } from "@/lib/api/locations.client";
import { useAuthStore } from "@/stores/auth.store";
import { NoAccessScreen } from "./no-access-screen";

const BYPASS_ROLES = new Set([
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "ONBOARDING_AGENT",
  "FINANCIAL_AGENT",
]);

export function AccessGate({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);

  const bypass = !!user && BYPASS_ROLES.has(user.role);

  const locationsQuery = useQuery({
    queryKey: ["locations", "list"],
    queryFn: locationsClient.list,
    enabled: !!user && !bypass,
    staleTime: 60_000,
  });

  if (!user) return <>{children}</>;
  if (bypass) return <>{children}</>;

  if (locationsQuery.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-50">
        <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
      </div>
    );
  }

  if ((locationsQuery.data ?? []).length === 0) {
    return <NoAccessScreen />;
  }

  return <>{children}</>;
}
