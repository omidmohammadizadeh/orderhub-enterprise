"use client";

// Uber Eats order-action test panel — fires the Order Fulfillment suite's
// remaining certification endpoints (adjust price, update ready time,
// validate item fulfillment, resolve fulfillment issues, replacement
// recommendations) against a live order so each can be tested one-by-one.
// Every call surfaces its result as a toast and writes a row to the Logs
// page with Uber's HTTP acknowledgment.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, FlaskConical, ChevronDown, ChevronRight } from "lucide-react";
import toast from "react-hot-toast";
import { apiClient } from "@/lib/api/client";

type Action = {
  key: string;
  label: string;
  hint: string;
  run: (orderId: string) => Promise<any>;
};

const ACTIONS: Action[] = [
  {
    key: "adjust-price",
    label: "Adjust price (+£1)",
    hint: "REQUESTED_ADD_ONS",
    run: (id) =>
      apiClient.post(`/v1/integrations/ubereats/order/${id}/adjust-price`, {
        amountPounds: 1,
        taxRate: "20",
        reason: "REQUESTED_ADD_ONS",
        customReason: "Certification test",
      }),
  },
  {
    key: "ready-time",
    label: "Update ready time (+15 min)",
    hint: "update-ready-time",
    run: (id) =>
      apiClient.post(`/v1/integrations/ubereats/order/${id}/ready-time`, {
        minutesFromNow: 15,
      }),
  },
  {
    key: "validate",
    label: "Validate item fulfillment",
    hint: "auto-fills first item",
    run: (id) =>
      apiClient.post(
        `/v1/integrations/ubereats/order/${id}/validate-item-fulfillment`,
        {},
      ),
  },
  {
    key: "resolve",
    label: "Resolve fulfillment issues",
    hint: "OUT_OF_ITEM · ASK_CUSTOMER",
    run: (id) =>
      apiClient.post(
        `/v1/integrations/ubereats/order/${id}/resolve-fulfillment-issues`,
        {},
      ),
  },
  {
    key: "replacement",
    label: "Get replacement recommendations",
    hint: "retail/grocery only — restaurants error",
    run: (id) =>
      apiClient.post(
        `/v1/integrations/ubereats/order/${id}/replacement-recommendations`,
        {},
      ),
  },
];

export function UberEatsOrderActionsPanel({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: async (a: Action) => {
      setBusy(a.key);
      const res = await a.run(orderId);
      return { a, data: res.data };
    },
    onSuccess: ({ a, data }) => {
      const http = data?.uberHttpStatus ?? data?.prep?.uberHttpStatus;
      toast.success(
        `${a.label} → Uber ${http ? `${http} OK` : "OK"} (see Logs)`,
      );
    },
    onError: (e: any, a) =>
      toast.error(
        `${a?.label ?? "Action"} failed: ${e?.response?.data?.message ?? e?.message ?? "error"}`,
      ),
    onSettled: () => setBusy(null),
  });

  return (
    <div className="border-b border-zinc-100 px-5 py-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400 hover:text-zinc-600"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <FlaskConical className="h-3.5 w-3.5" />
        Uber Eats API tests
      </button>
      {open && (
        <div className="mt-2.5 space-y-1.5">
          <p className="text-[11px] text-zinc-500">
            Fire each Order Fulfillment endpoint against this live order for
            certification. Results appear in Logs with Uber's HTTP status.
          </p>
          {ACTIONS.map((a) => (
            <button
              key={a.key}
              onClick={() => run.mutate(a)}
              disabled={busy !== null}
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left text-xs hover:border-zinc-900 disabled:opacity-50"
            >
              <span className="font-medium text-zinc-800">{a.label}</span>
              <span className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-400">{a.hint}</span>
                {busy === a.key && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
