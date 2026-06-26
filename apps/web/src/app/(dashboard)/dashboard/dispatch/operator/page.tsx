"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

// Phase AX-3b — Operator Dashboard (placeholder). Will hold: analytics,
// out-for-delivery, delivered, attention (orange orders), online/busy drivers,
// skipped/cancelled deliveries, per-driver cash-up, and active-jobs reassign.
export default function OperatorDashboardPage() {
  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <Link
          href="/dashboard/dispatch"
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
        >
          <ArrowLeft className="h-4 w-4" /> Dispatch
        </Link>
        <h1 className="text-xl font-semibold">Operator dashboard</h1>
      </div>
      <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
        Coming next — analytics, out-for-delivery, attention, online/busy drivers,
        skipped/cancelled, per-driver cash-up, and active-jobs reassignment.
      </div>
    </div>
  );
}
