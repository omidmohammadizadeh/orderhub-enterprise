"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { menusClient } from "@/lib/api/menus.client";

// ── Phase AK — Menu import dialog ───────────────────────────────────────────
//
// Operators paste raw JSON exported from the Uber Eats Restaurant Manager
// or Deliveroo Hub. The classifier turns it into our normalized shape and
// the writer upserts atomically.
//
// We don't yet wire OAuth tokens for live fetches — that's Phase AL when
// we connect real Uber/Deliveroo accounts. Pasted JSON is enough for
// operators piloting from a sandbox or fixture.

interface Props {
  menuId: string;
  open: boolean;
  onClose: () => void;
}

type Platform = "uber" | "deliveroo";

export function ImportMenuDialog({ menuId, open, onClose }: Props) {
  const qc = useQueryClient();
  const [platform, setPlatform] = useState<Platform>("uber");
  const [payloadText, setPayloadText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    createdCount: number;
    updatedCount: number;
    warnings: string[];
    unchanged?: boolean;
  } | null>(null);

  const importMutation = useMutation({
    mutationFn: async () => {
      let payload: unknown;
      try {
        payload = JSON.parse(payloadText);
      } catch (e) {
        throw new Error("Pasted text is not valid JSON");
      }
      if (platform === "uber") {
        return menusClient.importUber(menuId, { payload });
      }
      return menusClient.importDeliveroo(menuId, { payload });
    },
    onSuccess: (res) => {
      setSuccess(res);
      setError(null);
      qc.invalidateQueries({ queryKey: ["menu", menuId] });
    },
    onError: (err: any) => {
      setError(err?.response?.data?.message ?? err?.message ?? "Import failed");
      setSuccess(null);
    },
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">Import menu</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Paste the raw menu JSON exported from the platform's restaurant
              dashboard.
            </p>
          </div>
          <button
            onClick={() => {
              onClose();
              setPayloadText("");
              setError(null);
              setSuccess(null);
            }}
            className="rounded-md p-1.5 hover:bg-zinc-100"
          >
            <X className="h-4 w-4 text-zinc-500" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div className="flex gap-2">
            {(["uber", "deliveroo"] as Platform[]).map((p) => (
              <button
                key={p}
                onClick={() => setPlatform(p)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium capitalize ${
                  platform === p
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300"
                }`}
              >
                {p === "uber" ? "Uber Eats" : "Deliveroo"}
              </button>
            ))}
          </div>

          <div>
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
              Menu JSON payload
            </label>
            <textarea
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
              placeholder={
                platform === "uber"
                  ? '{ "menus": [...], "categories": [...], "items": [...], "modifier_groups": [...] }'
                  : '{ "menu": { "items": [...], "categories": [...], "modifiers": [...] } }'
              }
              rows={12}
              className="mt-1 w-full resize-y rounded-lg border border-zinc-200 px-3 py-2 font-mono text-[11px] focus:border-zinc-900 focus:outline-none"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="flex flex-col gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span className="font-medium">
                  {success.unchanged
                    ? "No changes — menu already up to date."
                    : `Imported: ${success.createdCount} new, ${success.updatedCount} updated.`}
                </span>
              </div>
              {success.warnings.length > 0 && (
                <ul className="list-disc pl-5 text-amber-700">
                  {success.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-zinc-300"
          >
            Close
          </button>
          <button
            onClick={() => importMutation.mutate()}
            disabled={!payloadText.trim() || importMutation.isPending}
            className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {importMutation.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            Run import
          </button>
        </div>
      </div>
    </div>
  );
}
