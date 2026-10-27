"use client";

// Console → Applications: shops that applied through the public partner form.
// The checks we can run ourselves (Companies House, the FSA rating) are
// already done when a row appears; ID and bank statement are a person's job.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Loader2, RefreshCw, Search, X } from "lucide-react";
import toast from "react-hot-toast";
import {
  eflAdminClient,
  type EflApplication,
  type EflApplicationChecks,
  type EflApplicationRow,
  type EflApplicationStatus,
} from "@/lib/api/efl.client";

const STATUS_LOOK: Record<EflApplicationStatus, { text: string; cls: string }> = {
  NEW: { text: "New", cls: "bg-[#0B0B0B] text-white" },
  WAITING_INFO: { text: "Waiting for info", cls: "bg-amber-100 text-amber-900" },
  APPROVED: { text: "Approved", cls: "bg-[#D4FF3F] text-[#0B0B0B]" },
  DECLINED: { text: "Declined", cls: "bg-red-50 text-red-700" },
};

export function ConsoleApplications() {
  const list = useQuery({ queryKey: ["efl-admin", "applications"], queryFn: eflAdminClient.applications });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rows = list.data ?? [];
  const current = selectedId ?? rows[0]?.id ?? null;

  return (
    <>
      <header>
        <h1 className="text-[28px] font-extrabold tracking-tight">Shop applications</h1>
        <p className="mt-1 text-[13px] text-zinc-600">
          From the &ldquo;Partner with Eat For Less&rdquo; form. The automatic checks run as soon as a shop applies; you
          make the final call.
        </p>
      </header>

      {list.isLoading ? (
        <p className="text-sm text-zinc-500">Loading applications…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
          No applications yet. Shops apply at /partner.
        </p>
      ) : (
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          <ul className="flex flex-col gap-1 rounded-2xl border border-zinc-200 bg-white p-2 lg:w-80 lg:shrink-0">
            {rows.map((a) => (
              <li key={a.id}>
                <ApplicationRow app={a} selected={a.id === current} onSelect={() => setSelectedId(a.id)} />
              </li>
            ))}
          </ul>
          {current && <ApplicationDetail key={current} id={current} />}
        </div>
      )}
    </>
  );
}

function ApplicationRow({
  app,
  selected,
  onSelect,
}: {
  app: EflApplicationRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const look = STATUS_LOOK[app.status];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={
        "flex w-full flex-col gap-1 rounded-xl px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20 " +
        (selected ? "bg-[#F4F4F1]" : "hover:bg-[#FAFAF8]")
      }
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate text-[15px] font-extrabold">{app.businessName}</span>
        <span className={`shrink-0 rounded-lg px-2 py-0.5 text-[11px] font-extrabold ${look.cls}`}>{look.text}</span>
      </span>
      <span className="text-xs text-zinc-500">
        {app.city} · {new Date(app.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
      </span>
    </button>
  );
}

function ApplicationDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["efl-admin", "application", id], queryFn: () => eflAdminClient.application(id) });
  const [note, setNote] = useState("");

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["efl-admin", "application", id] });
    qc.invalidateQueries({ queryKey: ["efl-admin", "applications"] });
  };
  const recheck = useMutation({
    mutationFn: () => eflAdminClient.recheckApplication(id),
    onSuccess: () => {
      toast.success("Checks run again");
      refresh();
    },
    onError: () => toast.error("Couldn't run the checks"),
  });
  const decide = useMutation({
    mutationFn: (status: "APPROVED" | "DECLINED" | "WAITING_INFO") => eflAdminClient.decideApplication(id, status, note),
    onSuccess: () => {
      toast.success("Decision saved");
      refresh();
    },
    onError: () => toast.error("Couldn't save the decision"),
  });

  const app = detail.data;
  if (!app) {
    return (
      <div className="flex flex-1 items-center gap-2 rounded-2xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…
      </div>
    );
  }
  const open = app.status === "NEW" || app.status === "WAITING_INFO";

  return (
    <article className="flex min-w-0 flex-1 flex-col gap-5 rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-extrabold tracking-tight">{app.businessName}</h2>
          <p className="text-[13px] text-zinc-600">
            {app.addressLine1}, {app.city} {app.postcode}
          </p>
        </div>
        <span className={`rounded-lg px-2.5 py-1 text-xs font-extrabold ${STATUS_LOOK[app.status].cls}`}>
          {STATUS_LOOK[app.status].text}
        </span>
      </div>

      <dl className="grid gap-x-5 gap-y-3 text-[13px] sm:grid-cols-2">
        <Item label="Owner" value={`${app.firstName} ${app.lastName}`} />
        <Item label="Company number" value={app.companyNumber ?? "Not given"} />
        <Item label="Mobile" value={app.phone} href={`tel:${app.phone}`} />
        <Item label="Email" value={app.email} href={`mailto:${app.email}`} />
        <Item label="Cuisine" value={app.cuisine ?? "—"} />
        <Item label="Menu link" value={app.menuUrl ? "Open menu" : "Not given"} href={app.menuUrl ?? undefined} external />
      </dl>

      <section aria-labelledby="checks">
        <div className="mb-1 flex items-center justify-between">
          <h3 id="checks" className="text-[15px] font-extrabold">
            Checks
          </h3>
          <button
            type="button"
            onClick={() => recheck.mutate()}
            disabled={recheck.isPending}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-bold text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
          >
            <RefreshCw className={"h-3.5 w-3.5 " + (recheck.isPending ? "animate-spin" : "")} aria-hidden="true" />
            Run again
          </button>
        </div>
        <ul className="divide-y divide-zinc-100">
          {checkRows(app).map((c) => (
            <li key={c.label} className="flex items-center gap-3 py-2.5">
              <span
                aria-hidden="true"
                className={
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full " +
                  (c.tone === "ok" ? "bg-[#D4FF3F]" : c.tone === "bad" ? "bg-red-600 text-white" : "bg-amber-100 text-amber-900")
                }
              >
                {c.tone === "ok" ? (
                  <Check className="h-3.5 w-3.5" strokeWidth={3.2} />
                ) : c.tone === "bad" ? (
                  <X className="h-3.5 w-3.5" strokeWidth={3.2} />
                ) : (
                  <Search className="h-3.5 w-3.5" strokeWidth={2.6} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">{c.label}</span>
                <span className="block text-xs text-zinc-600">{c.detail}</span>
              </span>
              {c.href && (
                <a
                  href={c.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-zinc-100 px-2.5 text-xs font-bold hover:bg-zinc-200"
                >
                  View <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="decision" className="flex flex-col gap-2.5 border-t border-zinc-100 pt-4">
        <h3 id="decision" className="text-[15px] font-extrabold">
          Decision
        </h3>
        {app.decisionNote && <p className="rounded-lg bg-zinc-50 px-3 py-2 text-[13px] text-zinc-700">{app.decisionNote}</p>}
        {open ? (
          <>
            <label htmlFor="decision-note" className="text-xs font-semibold text-zinc-600">
              Note (kept with the application)
            </label>
            <textarea
              id="decision-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. ID name doesn't match — asked for a clearer photo"
              className="rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-[#0B0B0B] focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={decide.isPending}
                onClick={() => decide.mutate("APPROVED")}
                className="h-11 rounded-xl bg-[#0B0B0B] px-5 text-sm font-extrabold text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={decide.isPending}
                onClick={() => decide.mutate("WAITING_INFO")}
                className="h-11 rounded-xl bg-zinc-100 px-4 text-sm font-bold hover:bg-zinc-200 disabled:opacity-50"
              >
                Ask for more info
              </button>
              <button
                type="button"
                disabled={decide.isPending}
                onClick={() => decide.mutate("DECLINED")}
                className="h-11 rounded-xl bg-zinc-100 px-4 text-sm font-bold text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                Decline
              </button>
            </div>
            <p className="text-xs text-zinc-500">
              After approving: set the shop up in OrderHub (its location, brand and menu). It then switches Eat For
              Less on from its Platforms page and appears in Shops for you to approve.
            </p>
          </>
        ) : (
          <p className="text-[13px] text-zinc-600">
            {STATUS_LOOK[app.status].text}
            {app.decidedAt ? ` on ${new Date(app.decidedAt).toLocaleDateString("en-GB")}` : ""}.
          </p>
        )}
      </section>
      <p className="text-xs text-zinc-500">
        ID and bank statement links work for 10 minutes. The files are stored privately and seen only by Console admins.
      </p>
    </article>
  );
}

function checkRows(app: EflApplication) {
  const c: EflApplicationChecks = app.checks ?? {};
  const ch = c.companiesHouse;
  const hy = c.hygiene;
  const rows: Array<{ label: string; detail: string; tone: "ok" | "bad" | "review"; href?: string }> = [
    {
      label: "Companies House",
      tone: ch?.state === "OK" ? "ok" : ch?.state === "INACTIVE" || ch?.state === "NOT_FOUND" ? "bad" : "review",
      detail:
        ch?.state === "OK"
          ? `Active · ${ch.name ?? ""}`
          : ch?.state === "INACTIVE"
            ? `Found but not active · ${ch.name ?? ""}`
            : ch?.state === "NOT_FOUND"
              ? "No company with that number"
              : ch?.state === "NOT_GIVEN"
                ? "No company number given — may be a sole trader"
                : "Not checked: add COMPANIES_HOUSE_API_KEY to the API to check automatically",
    },
    {
      label: "Food hygiene rating (FSA)",
      tone: hy?.state === "OK" ? "ok" : hy?.state === "BELOW_MINIMUM" ? "bad" : "review",
      detail:
        hy?.state === "OK"
          ? `Rating ${hy.rating} · ${hy.businessName ?? ""}`
          : hy?.state === "BELOW_MINIMUM"
            ? `Rating ${hy.rating} · below your minimum of ${hy.minimum}`
            : c.checkedAt
              ? "No FSA record found at this postcode — ask for their ratings link"
              : "Checking…",
      href: hy?.establishmentId ? `https://ratings.food.gov.uk/business/${hy.establishmentId}` : undefined,
    },
    {
      label: "Photo ID",
      tone: "review",
      detail: app.hasIdDocument ? "Uploaded · check the name matches the owner" : "Not uploaded",
      href: app.idDocUrl ?? undefined,
    },
    {
      label: "Bank statement",
      tone: "review",
      detail: app.hasBankStatement ? "Uploaded · check the account name matches the business" : "Not uploaded",
      href: app.bankDocUrl ?? undefined,
    },
  ];
  return rows;
}

function Item({ label, value, href, external }: { label: string; value: string; href?: string; external?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="font-bold">
        {href ? (
          <a
            href={href}
            {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-900"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
