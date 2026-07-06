"use client";

// Uber Eats reporting — request standardized batch reports (Marketplace
// Reporting API) and download them once Uber's eats.report.success webhook
// delivers the section URLs. POST /v1/eats/report is async → workflow_id,
// then the report shows PENDING until the webhook lands, then READY with
// download links.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Loader2,
  FileText,
  Download,
  RefreshCw,
  CheckCircle2,
  Clock3,
} from "lucide-react";
import toast from "react-hot-toast";
import { apiClient } from "@/lib/api/client";

// The 9 report types + a friendly label and the date-range rule (from Uber's
// Reporting request-constraints table) so the operator picks a valid window.
const REPORT_TYPES: Array<{
  value: string;
  label: string;
  hint: string;
}> = [
  { value: "PAYMENT_DETAILS_REPORT", label: "Payment details", hint: "Up to 30 days" },
  { value: "ORDERS_AND_ITEMS_REPORT", label: "Orders & items", hint: "Up to 15 days" },
  { value: "FINANCE_SUMMARY_REPORT", label: "Finance summary", hint: "Up to 30 days" },
  { value: "ORDER_HISTORY_REPORT", label: "Order history", hint: "2–188 days ago" },
  { value: "DOWNTIME_REPORT", label: "Downtime", hint: "2–188 days ago" },
  {
    value: "ORDER_ERRORS_MENU_ITEM_REPORT",
    label: "Order errors — menu item",
    hint: "2–188 days ago",
  },
  {
    value: "ORDER_ERRORS_TRANSACTION_REPORT",
    label: "Order errors — transaction",
    hint: "4–190 days ago",
  },
  {
    value: "CUSTOMER_AND_DELIVERY_FEEDBACK_REPORT",
    label: "Customer & delivery feedback",
    hint: "2–188 days ago",
  },
  {
    value: "MENU_ITEM_FEEDBACK_REPORT",
    label: "Menu item feedback",
    hint: "2–188 days ago",
  },
];

type Report = {
  workflowId: string;
  reportType: string;
  startDate: string;
  endDate: string;
  requestedAt: string;
  status: "PENDING" | "READY";
  sections: Array<{ download_url?: string; content_type?: string; section_id?: string }>;
  receivedAt: string | null;
};

const isoDaysAgo = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
};

export function UberEatsReportingTab() {
  const [reportType, setReportType] = useState(REPORT_TYPES[0]!.value);
  const [startDate, setStartDate] = useState(isoDaysAgo(7));
  const [endDate, setEndDate] = useState(isoDaysAgo(1));

  const reports = useQuery({
    queryKey: ["ubereats-reports"],
    queryFn: () =>
      apiClient
        .get(`/v1/integrations/ubereats/reports`)
        .then((r) => r.data as { reports: Report[] }),
    refetchInterval: 15_000, // PENDING → READY when the webhook lands
    refetchOnWindowFocus: false,
  });

  const create = useMutation({
    mutationFn: () =>
      apiClient
        .post(`/v1/integrations/ubereats/reports`, {
          reportType,
          startDate,
          endDate,
        })
        .then((r) => r.data as { workflowId: string }),
    onSuccess: () => {
      toast.success("Report requested — it'll appear below when ready");
      reports.refetch();
    },
    onError: (e: any) =>
      toast.error(
        `Report request failed: ${e?.response?.data?.message ?? e?.message ?? "error"}`,
      ),
  });

  const typeLabel = (v: string) =>
    REPORT_TYPES.find((t) => t.value === v)?.label ?? v;
  const activeHint = REPORT_TYPES.find((t) => t.value === reportType)?.hint;

  return (
    <div className="space-y-4">
      {/* Request a report */}
      <section className="rounded-xl border border-zinc-200 bg-white p-4">
        <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-zinc-800">
          <FileText className="h-3.5 w-3.5 text-zinc-400" />
          Request a report
        </h3>
        <div className="space-y-2">
          <div>
            <label className="text-[11px] text-zinc-500">Report type</label>
            <select
              value={reportType}
              onChange={(e) => setReportType(e.target.value)}
              className="mt-0.5 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
            >
              {REPORT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="text-[11px] text-zinc-500">From</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-0.5 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
              />
            </div>
            <div className="flex-1">
              <label className="text-[11px] text-zinc-500">To</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="mt-0.5 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs focus:border-zinc-900 focus:outline-none"
              />
            </div>
          </div>
          {activeHint && (
            <p className="text-[10px] text-zinc-400">
              Allowed range: {activeHint}. Reports cover every connected Uber
              Eats store.
            </p>
          )}
          <button
            onClick={() => create.mutate()}
            disabled={create.isPending}
            className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Generate report
          </button>
        </div>
      </section>

      {/* Requested reports */}
      <section className="rounded-xl border border-zinc-200 bg-white p-4">
        <div className="mb-2.5 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-zinc-800">
            Requested reports
          </h3>
          <button
            onClick={() => reports.refetch()}
            disabled={reports.isFetching}
            className="flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[10px] text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3 w-3 ${reports.isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
        </div>

        {reports.isLoading ? (
          <p className="text-xs text-zinc-500">Loading…</p>
        ) : (reports.data?.reports ?? []).length === 0 ? (
          <p className="text-xs text-zinc-500">
            No reports requested yet. Generate one above.
          </p>
        ) : (
          <div className="space-y-1.5">
            {reports.data!.reports.map((r) => (
              <div
                key={r.workflowId || r.requestedAt}
                className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-zinc-800">
                    {typeLabel(r.reportType)}
                  </p>
                  <p className="text-[10px] text-zinc-500">
                    {r.startDate} → {r.endDate}
                  </p>
                </div>
                {r.status === "READY" ? (
                  <div className="flex items-center gap-1.5">
                    {(r.sections ?? []).length > 0 ? (
                      r.sections.map((s, i) => (
                        <a
                          key={s.section_id ?? i}
                          href={s.download_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-emerald-700"
                        >
                          <Download className="h-3 w-3" />
                          {r.sections.length > 1 ? `Part ${i + 1}` : "Download"}
                        </a>
                      ))
                    ) : (
                      <span className="flex items-center gap-1 text-[10px] text-emerald-700">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Ready
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="flex items-center gap-1 rounded-md bg-amber-100 px-2 py-1 text-[10px] font-medium text-amber-700">
                    <Clock3 className="h-3 w-3" />
                    Generating…
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-[10px] text-zinc-400">
          Uber generates reports asynchronously — a report can take a few
          minutes. This list refreshes automatically.
        </p>
      </section>
    </div>
  );
}
