"use client";

// Kitchen training — staff learn each product's "How to build" guide one
// step at a time and mark it learned. A guide edited after someone learned
// it shows as "Refresher" for them, so a recipe change reaches everyone.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  GraduationCap,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth.store";
import { buildGuidesClient, type TrainingOverviewRow } from "@/lib/api/build-guides.client";

const MANAGERS = ["PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "DARK_KITCHEN_MANAGER", "MANAGER"];
const OVERVIEW_QUERY = ["build-guide-training"] as const;

type Filter = "todo" | "trained" | "all";

export default function TrainingPage() {
  const role = useAuthStore((s) => (s as any).user?.role as string | undefined);
  const isManager = !!role && MANAGERS.includes(role);
  const [filter, setFilter] = useState<Filter>("todo");
  const [search, setSearch] = useState("");
  const [openGuide, setOpenGuide] = useState<string | null>(null);

  const q = useQuery({ queryKey: OVERVIEW_QUERY, queryFn: buildGuidesClient.trainingOverview });
  const rows = q.data ?? [];
  const todo = rows.filter((r) => r.myStatus !== "trained").length;

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (filter === "all" ||
          (filter === "todo" ? r.myStatus !== "trained" : r.myStatus === "trained")) &&
        (!s || r.name.toLowerCase().includes(s) || (r.brandName ?? "").toLowerCase().includes(s)),
    );
  }, [rows, filter, search]);

  const byBrand = useMemo(() => {
    const m = new Map<string, TrainingOverviewRow[]>();
    for (const r of shown) {
      const k = r.brandName ?? "Other";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return [...m.entries()];
  }, [shown]);

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-zinc-900">
            <GraduationCap className="h-5 w-5 text-orange-500" /> Kitchen training
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Learn every product&apos;s build, step by step.{" "}
            {rows.length > 0 && (
              <span className="font-medium text-zinc-700">
                {rows.length - todo} of {rows.length} learned
              </span>
            )}
          </p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products" className="pl-8" />
        </div>
      </div>

      {rows.length > 0 && (
        <div className="h-2 overflow-hidden rounded-full bg-zinc-200">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${((rows.length - todo) / rows.length) * 100}%` }}
          />
        </div>
      )}

      <div className="flex gap-1.5">
        {(
          [
            ["todo", `To learn (${todo})`],
            ["trained", `Learned (${rows.length - todo})`],
            ["all", `All (${rows.length})`],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={cn(
              "rounded-full px-3 py-1.5 text-sm font-medium",
              filter === k ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <div className="flex items-center justify-center py-20 text-sm text-zinc-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : q.isError ? (
        <p className="py-20 text-center text-sm text-red-600">Could not load training.</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 py-16 text-center">
          <GraduationCap className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-2 text-sm text-zinc-600">No build guides yet.</p>
          <p className="text-xs text-zinc-400">Add one with “How to build” on any product in the menu editor.</p>
        </div>
      ) : shown.length === 0 ? (
        <p className="py-16 text-center text-sm text-zinc-500">
          {filter === "todo" && !search ? "All learned — nice work." : "Nothing matches."}
        </p>
      ) : (
        byBrand.map(([brand, list]) => (
          <section key={brand} className="space-y-2">
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400">{brand}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {list.map((r) => (
                <GuideCard key={r.id} row={r} isManager={isManager} onOpen={() => setOpenGuide(r.id)} />
              ))}
            </div>
          </section>
        ))
      )}

      {openGuide && <Walkthrough guideId={openGuide} onClose={() => setOpenGuide(null)} />}
    </div>
  );
}

function StatusBadge({ status }: { status: TrainingOverviewRow["myStatus"] }) {
  if (status === "trained")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
        <CheckCircle2 className="h-3 w-3" /> Learned
      </span>
    );
  if (status === "refresher")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
        <RefreshCw className="h-3 w-3" /> Changed — refresh
      </span>
    );
  return <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-800">New</span>;
}

function GuideCard({ row, isManager, onOpen }: { row: TrainingOverviewRow; isManager: boolean; onOpen: () => void }) {
  const [showStaff, setShowStaff] = useState(false);
  const staff = useQuery({
    queryKey: ["build-guide-training-staff", row.id],
    queryFn: () => buildGuidesClient.whoTrained(row.id),
    enabled: showStaff,
  });
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <button type="button" onClick={onOpen} className="block w-full text-left">
        {row.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={row.imageUrl} alt="" className="aspect-[16/10] w-full object-cover" />
        ) : (
          <div className="flex aspect-[16/10] w-full items-center justify-center bg-zinc-100">
            <GraduationCap className="h-8 w-8 text-zinc-300" />
          </div>
        )}
        <div className="space-y-1.5 p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold leading-tight text-zinc-900">{row.name}</p>
            <StatusBadge status={row.myStatus} />
          </div>
          <p className="text-xs text-zinc-500">{row.stepCount} steps</p>
        </div>
      </button>
      {isManager && (
        <div className="border-t border-zinc-100 px-3 py-2">
          <button
            type="button"
            onClick={() => setShowStaff((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-600 hover:text-zinc-900"
          >
            <Users className="h-3.5 w-3.5" /> {row.trainedCount} staff up to date
          </button>
          {showStaff && (
            <ul className="mt-1.5 space-y-0.5 text-xs">
              {staff.isLoading ? (
                <li className="text-zinc-400">Loading…</li>
              ) : (staff.data ?? []).length === 0 ? (
                <li className="text-zinc-400">Nobody yet.</li>
              ) : (
                staff.data!.map((p, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className={p.current ? "text-zinc-800" : "text-amber-700"}>
                      {p.name}
                      {!p.current && " (before last change)"}
                    </span>
                    <span className="text-zinc-400">{new Date(p.completedAt).toLocaleDateString()}</span>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Walkthrough({ guideId, onClose }: { guideId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["build-guide-training-guide", guideId],
    queryFn: () => buildGuidesClient.trainingGuide(guideId),
  });
  const [i, setI] = useState(0);
  const steps = q.data?.steps ?? [];
  const total = steps.length + 1; // + the pack / finish screen
  const atEnd = i >= steps.length;

  const complete = useMutation({
    mutationFn: () => buildGuidesClient.completeTraining(guideId),
    onSuccess: () => {
      toast.success(`${q.data?.name ?? "Guide"} learned`);
      qc.invalidateQueries({ queryKey: OVERVIEW_QUERY });
      onClose();
    },
    onError: () => toast.error("Couldn't save — try again"),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setI((v) => Math.min(v + 1, total - 1));
      if (e.key === "ArrowLeft") setI((v) => Math.max(v - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, total]);

  const step = steps[i];
  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col bg-zinc-950 text-zinc-100">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-wider text-orange-400">{q.data?.brandName ?? "Training"}</p>
          <h2 className="truncate text-lg font-black">{q.data?.name ?? "…"}</h2>
        </div>
        <button onClick={onClose} className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white" aria-label="Close">
          <X className="h-6 w-6" />
        </button>
      </div>
      <div className="flex gap-1 px-4">
        {Array.from({ length: total }).map((_, k) => (
          <div key={k} className={cn("h-1.5 flex-1 rounded-full", k <= i ? "bg-orange-500" : "bg-zinc-800")} />
        ))}
      </div>

      <div className="flex flex-1 items-center justify-center overflow-y-auto p-4">
        {q.isLoading ? (
          <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
        ) : q.isError ? (
          <p className="text-red-400">Could not load this guide.</p>
        ) : !atEnd && step ? (
          <div className="w-full max-w-3xl space-y-4">
            {step.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={step.imageUrl} alt="" className="max-h-[50vh] w-full rounded-2xl object-cover" />
            )}
            <div className="flex items-start gap-4">
              <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-orange-500 text-2xl font-black">
                {i + 1}
              </span>
              <p className="whitespace-pre-line pt-1 text-2xl font-semibold leading-snug sm:text-3xl">{step.text}</p>
            </div>
            <div className="flex flex-wrap gap-2 pl-16">
              {step.amount && (
                <span className="rounded-lg bg-amber-400 px-3 py-1 text-base font-bold text-zinc-950">{step.amount}</span>
              )}
              {step.tools?.map((t) => (
                <span key={t} className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1 text-base text-zinc-200">
                  <Wrench className="h-4 w-4" /> {t}
                </span>
              ))}
            </div>
            {(step.onlyWith?.length ?? 0) > 0 && (
              <p className="pl-16 text-base font-semibold text-amber-300">
                Only when the customer adds: {step.onlyWith!.join(", ")}
              </p>
            )}
            {(step.skipWith?.length ?? 0) > 0 && (
              <p className="pl-16 text-base font-semibold text-red-300">
                Skip this when the customer chooses: {step.skipWith!.join(", ")}
              </p>
            )}
          </div>
        ) : (
          <div className="w-full max-w-2xl space-y-6 text-center">
            {q.data?.packNote && (
              <div className="flex items-start gap-3 rounded-2xl border border-emerald-700 bg-emerald-950/60 p-5 text-left">
                <Package className="mt-1 h-6 w-6 shrink-0 text-emerald-400" />
                <div>
                  <p className="text-sm font-bold uppercase tracking-wider text-emerald-400">Pack</p>
                  <p className="whitespace-pre-line text-xl">{q.data.packNote}</p>
                </div>
              </div>
            )}
            <div>
              <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-400" />
              <p className="mt-2 text-2xl font-black">That&apos;s the build.</p>
              <p className="text-zinc-400">Confident you can make it without the chart?</p>
            </div>
            <button
              onClick={() => complete.mutate()}
              disabled={complete.isPending}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-3 text-lg font-bold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {complete.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
              I&apos;ve learned this
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-zinc-800 p-4">
        <button
          onClick={() => setI((v) => Math.max(v - 1, 0))}
          disabled={i === 0}
          className="inline-flex items-center gap-2 rounded-xl bg-zinc-800 px-5 py-3 text-base font-semibold disabled:opacity-30"
        >
          <ArrowLeft className="h-5 w-5" /> Back
        </button>
        <span className="text-sm text-zinc-500">
          {atEnd ? "Finish" : `Step ${i + 1} of ${steps.length}`}
        </span>
        <button
          onClick={() => setI((v) => Math.min(v + 1, total - 1))}
          disabled={atEnd}
          className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-5 py-3 text-base font-semibold text-white disabled:opacity-30"
        >
          Next <ArrowRight className="h-5 w-5" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
