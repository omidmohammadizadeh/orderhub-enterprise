"use client";

// Admin Dashboard → Prospects → one shop. Route shell only, as with the list.

import { use } from "react";
import { Lock } from "lucide-react";
import { useAuthStore } from "@/stores/auth.store";
import { ProspectDetail } from "@/components/admin/prospects/prospect-detail";

export default function ProspectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const user = useAuthStore((s) => s.user);

  if (user && user.role !== "PLATFORM_ADMIN") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Lock className="mb-3 h-10 w-10 text-zinc-300" aria-hidden="true" />
        <p className="font-medium text-zinc-500">Admin only</p>
      </div>
    );
  }

  return <ProspectDetail id={id} />;
}
