"use client";

// Admin Dashboard — the platform team's own console.
//
// Everything here changes something for OTHER people: what a tenant's staff
// can see, whether a location is allowed to trade. That's why it's one
// signposted place rather than more PLATFORM_ADMIN entries scattered through
// a sidebar built for restaurant operators.

import Link from "next/link";
import {
  ArrowRight,
  ClipboardCheck,
  LayoutList,
  Lock,
  Rocket,
  ShieldCheck,
} from "lucide-react";
import { useAuthStore } from "@/stores/auth.store";

interface AdminTool {
  href: string;
  title: string;
  blurb: string;
  icon: React.ElementType;
}

const TOOLS: AdminTool[] = [
  {
    href: "/dashboard/admin/dashboard-access",
    title: "Dashboard access",
    blurb:
      "Choose which sidebar tabs a location can see. Switch off Tables for a dark kitchen and it disappears for everyone there — owners included.",
    icon: LayoutList,
  },
  {
    href: "/dashboard/admin/go-live",
    title: "Go-live control",
    blurb:
      "Readiness scores per location, and the switch that lets a shop start taking real orders.",
    icon: Rocket,
  },
  {
    href: "/dashboard/admin/release-readiness",
    title: "Release readiness",
    blurb:
      "The pre-deploy checklist across integrations, printing and payments.",
    icon: ClipboardCheck,
  },
];

export default function AdminDashboardPage() {
  const user = useAuthStore((s) => s.user);

  // Server enforces the role on every endpoint behind these pages; this is
  // the friendly version of the same answer.
  if (user && user.role !== "PLATFORM_ADMIN") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Lock className="mb-3 h-10 w-10 text-zinc-300" aria-hidden="true" />
        <p className="font-medium text-zinc-500">Admin only</p>
        <p className="mt-1 text-sm text-zinc-400">
          The admin dashboard is for the platform team.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-zinc-900">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" /> Admin Dashboard
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          Platform-team controls. Changes made here apply to customers, not to
          your own account.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {TOOLS.map((tool) => (
          <Link
            key={tool.href}
            href={tool.href}
            className="group flex flex-col rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition-colors hover:border-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-100 text-zinc-700 transition-colors group-hover:bg-orange-50 group-hover:text-orange-600">
              <tool.icon className="h-5 w-5" aria-hidden="true" />
            </div>
            <p className="mt-3 text-sm font-semibold text-zinc-900">
              {tool.title}
            </p>
            <p className="mt-1 flex-1 text-sm leading-relaxed text-zinc-500">
              {tool.blurb}
            </p>
            <span className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-orange-600">
              Open
              <ArrowRight
                className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
