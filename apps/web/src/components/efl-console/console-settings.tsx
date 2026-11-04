"use client";

// Console → Settings: the platform rules every Eat For Less order follows.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { eflAdminClient, type EflConfig } from "@/lib/api/efl.client";

type NumericKey = Exclude<keyof EflConfig, "pinForNewCustomers">;

const FIELDS: Array<{ key: NumericKey; label: string; hint: string; prefix?: string; suffix?: string; step: number }> = [
  { key: "defaultCommissionPercent", label: "Default commission", hint: "On the food, for every shop without its own rate.", suffix: "%", step: 0.5 },
  { key: "pinMinOrderTotal", label: "Delivery PIN from", hint: "Orders at or above this total need the PIN at the door.", prefix: "£", step: 1 },
  { key: "firstOrderMaxTotal", label: "Largest first order", hint: "A new account's first order can't be bigger than this.", prefix: "£", step: 5 },
  { key: "maxOrdersPerHour", label: "Orders per account per hour", hint: "More than this in an hour is paused.", step: 1 },
  { key: "minHygieneRating", label: "Lowest food hygiene rating", hint: "Shops below this are hidden automatically (0–5).", step: 1 },
];

export function ConsoleSettings() {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ["efl-admin", "config"], queryFn: eflAdminClient.config });
  const [draft, setDraft] = useState<EflConfig | null>(null);
  useEffect(() => {
    if (config.data) setDraft(config.data);
  }, [config.data]);

  const save = useMutation({
    mutationFn: (next: EflConfig) => eflAdminClient.updateConfig(next),
    onSuccess: (next) => {
      qc.setQueryData(["efl-admin", "config"], next);
      toast.success("Settings saved");
    },
    onError: (err: any) => toast.error(err?.response?.data?.message?.toString() ?? "Couldn't save"),
  });

  const dirty = !!draft && !!config.data && JSON.stringify(draft) !== JSON.stringify(config.data);

  return (
    <>
      <header>
        <h1 className="text-[28px] font-extrabold tracking-tight">Settings</h1>
        <p className="mt-1 text-[13px] text-zinc-600">The rules every Eat For Less order follows. Changes apply to new orders.</p>
      </header>

      {!draft ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(draft);
          }}
          className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-5"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <label key={f.key} className="flex flex-col gap-1.5">
                <span className="text-sm font-bold">{f.label}</span>
                <span className="flex h-11 items-center rounded-xl border border-zinc-300 px-3 focus-within:border-[#0B0B0B] focus-within:ring-2 focus-within:ring-zinc-900/10">
                  {f.prefix && <span className="mr-1 text-zinc-500">{f.prefix}</span>}
                  <input
                    type="number"
                    inputMode="decimal"
                    step={f.step}
                    min={0}
                    value={draft[f.key]}
                    onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
                    className="w-full bg-transparent text-base font-bold tabular-nums outline-none"
                  />
                  {f.suffix && <span className="ml-1 text-zinc-500">{f.suffix}</span>}
                </span>
                <span className="text-xs text-zinc-500">{f.hint}</span>
              </label>
            ))}
            <label className="flex items-start gap-3 rounded-xl border border-zinc-200 p-3.5">
              <input
                type="checkbox"
                checked={draft.pinForNewCustomers}
                onChange={(e) => setDraft({ ...draft, pinForNewCustomers: e.target.checked })}
                className="mt-0.5 h-4 w-4 accent-[#0B0B0B]"
              />
              <span>
                <span className="block text-sm font-bold">Delivery PIN for new customers</span>
                <span className="block text-xs text-zinc-500">Every delivery to a customer's first account, whatever the total.</span>
              </span>
            </label>
          </div>
          <div className="flex justify-end gap-2 border-t border-zinc-100 pt-4">
            {dirty && (
              <button
                type="button"
                onClick={() => config.data && setDraft(config.data)}
                className="h-10 rounded-xl px-4 text-sm font-semibold text-zinc-600 hover:bg-zinc-100"
              >
                Discard
              </button>
            )}
            <button
              type="submit"
              disabled={!dirty || save.isPending}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#0B0B0B] px-5 text-sm font-bold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Save settings
            </button>
          </div>
        </form>
      )}
    </>
  );
}
