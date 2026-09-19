"use client";

// Dojo card machines on the Card readers settings page: connect the
// location's Dojo account, see its machines, and switch Pay at Table on.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Pencil, Utensils } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { dojoClient, type DojoStatus } from "@/lib/api/dojo.client";

const STATUS_STYLE: Record<string, string> = {
  Available: "bg-emerald-50 text-emerald-700",
  InUse: "bg-amber-50 text-amber-700",
  Offline: "bg-zinc-100 text-zinc-500",
};

export function DojoCardMachines({ locationId }: { locationId: string }) {
  const qc = useQueryClient();
  const key = ["dojo-status", locationId];
  const q = useQuery({ queryKey: key, queryFn: () => dojoClient.status(locationId) });
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(label);
    try {
      const res = await fn();
      if (res && typeof res === "object" && "partnerIdsConfigured" in (res as object)) {
        qc.setQueryData(key, res as DojoStatus);
      } else {
        await qc.invalidateQueries({ queryKey: key });
      }
      toast.success(ok);
      return true;
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? e?.message ?? "Something went wrong");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const s = q.data;

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4" aria-labelledby="dojo-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="dojo-heading" className="text-sm font-semibold text-zinc-900">
            Dojo card machines
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            Already have Dojo? Connect it and send payments from the till straight to your Dojo
            machine. The money settles to your own Dojo account.
          </p>
        </div>
        {s?.connected && (
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              s.environment === "sandbox" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"
            }`}
          >
            {s.environment === "sandbox" ? "Sandbox — no real money" : "Live"}
          </span>
        )}
      </div>

      {q.isLoading ? (
        <div className="mt-3 flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-400" aria-label="Loading" />
        </div>
      ) : !s?.connected ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run("connect", () => dojoClient.connect(locationId, apiKey.trim()), "Dojo connected")) {
              setApiKey("");
            }
          }}
        >
          <label htmlFor="dojo-key" className="text-xs font-medium text-zinc-700">
            Dojo secret API key
          </label>
          <div className="flex gap-2">
            <input
              id="dojo-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk_prod_…"
              className="flex-1 rounded-md border border-zinc-200 px-3 py-2 font-mono text-sm"
            />
            <Button type="submit" disabled={!apiKey.trim() || busy !== null}>
              {busy === "connect" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect"}
            </Button>
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-500">
            Find it in the Dojo Developer Portal under this location&rsquo;s API keys. Use a{" "}
            <code>sk_sandbox_</code> key to test with Dojo&rsquo;s sandbox machines first.
          </p>
          {s && !s.partnerIdsConfigured && (
            <p className="rounded-md bg-amber-50 p-2 text-[11px] text-amber-800">
              OrderHub&rsquo;s Dojo partner id isn&rsquo;t set up on the server yet, so Dojo will
              refuse card-machine requests. Contact OrderHub support.
            </p>
          )}
        </form>
      ) : (
        <div className="mt-3 space-y-4">
          <p className="text-xs text-zinc-500">
            Key {s.keyHint} · connected {new Date(s.connectedAt).toLocaleDateString()}
          </p>

          {s.terminalsError && (
            <p className="rounded-md bg-red-50 p-2 text-xs text-red-700">
              Couldn&rsquo;t reach Dojo just now: {s.terminalsError}
            </p>
          )}
          {s.terminals.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No card machines on this Dojo account yet.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {s.terminals.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                  {renaming?.id === t.id ? (
                    <form
                      className="flex flex-1 gap-2"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (
                          await run(
                            "rename",
                            () => dojoClient.renameTerminal(locationId, t.id, renaming.label),
                            "Renamed",
                          )
                        ) {
                          setRenaming(null);
                        }
                      }}
                    >
                      <input
                        aria-label="Card machine name"
                        autoFocus
                        value={renaming.label}
                        onChange={(e) => setRenaming({ id: t.id, label: e.target.value })}
                        className="flex-1 rounded-md border border-zinc-200 px-2 py-1 text-sm"
                      />
                      <Button type="submit" size="sm" disabled={busy !== null}>
                        Save
                      </Button>
                    </form>
                  ) : (
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-900">{t.label}</p>
                      {t.tid && <p className="text-xs text-zinc-500">TID {t.tid}</p>}
                    </div>
                  )}
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        STATUS_STYLE[t.status] ?? "bg-zinc-100 text-zinc-500"
                      }`}
                    >
                      {t.status === "InUse" ? "In use" : t.status}
                    </span>
                    {renaming?.id !== t.id && (
                      <button
                        type="button"
                        onClick={() => setRenaming({ id: t.id, label: t.label })}
                        className="rounded p-1 text-zinc-400 hover:text-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
                        aria-label={`Rename ${t.label}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="rounded-md border border-zinc-200 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
                  <Utensils className="h-4 w-4" /> Pay at Table
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                  Waiters pick a table on the Dojo machine, show the bill and take the card at the
                  table. Split payments and tips are recorded here automatically, and the table
                  closes when it&rsquo;s paid.
                </p>
              </div>
              {s.payAtTable.enabled && (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-label="On" />
              )}
            </div>
            <div className="mt-2">
              {s.payAtTable.enabled ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    run("pat", () => dojoClient.disablePayAtTable(locationId), "Pay at Table turned off")
                  }
                >
                  {busy === "pat" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Turn off"}
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    run("pat", () => dojoClient.enablePayAtTable(locationId), "Pay at Table is on")
                  }
                  className="bg-zinc-900 text-white hover:bg-zinc-800"
                >
                  {busy === "pat" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Turn on Pay at Table"}
                </Button>
              )}
            </div>
          </div>

          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm("Disconnect Dojo from this location? The till will stop offering Dojo machines.")) {
                void run("disconnect", () => dojoClient.disconnect(locationId), "Dojo disconnected");
              }
            }}
            className="text-xs text-zinc-500 underline hover:text-red-600"
          >
            Disconnect Dojo
          </button>
        </div>
      )}
    </section>
  );
}
