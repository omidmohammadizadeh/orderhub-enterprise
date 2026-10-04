"use client";

// Welcome + win-back emails that send themselves. One card each per shop:
// what it does, whether it's on, and what it has earned.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Gift, HeartHandshake, Loader2, Store } from "lucide-react";
import type { EmailAutomationType } from "@orderhub/shared";
import {
  apiErrorMessage,
  emailMarketingClient,
  type EmailAutomationCard,
} from "@/lib/api/email-marketing.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { cn } from "@/lib/utils";

const ICON: Record<EmailAutomationType, any> = { WELCOME: Gift, WIN_BACK: HeartHandshake };

export function AutomationsTab() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const { data, isLoading, error } = useQuery({
    queryKey: ["email-mkt", "automations", locationId],
    queryFn: () => emailMarketingClient.automations(locationId!),
    enabled: !!locationId,
  });

  if (!locationId) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 bg-white px-6 py-12 text-center">
        <Store className="mx-auto h-8 w-8 text-indigo-400" />
        <h3 className="mt-3 text-base font-semibold text-zinc-900">Pick a shop first</h3>
        <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
          Automatic emails are set up per shop. Choose one in the location switcher at the top of the sidebar.
        </p>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="flex justify-center py-12 text-zinc-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (error) return <p className="text-sm text-rose-600">{apiErrorMessage(error)}</p>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-600">
        Set them up once and they run by themselves, sending between 10am and 8pm. Only subscribed customers are
        emailed, and each person gets each email at most once in a while, never repeatedly.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {(data ?? []).map((card) => (
          <AutomationCard key={card.type} card={card} locationId={locationId} />
        ))}
      </div>
    </div>
  );
}

function AutomationCard({ card, locationId }: { card: EmailAutomationCard; locationId: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const Icon = ICON[card.type];
  const a = card.automation;
  const setup = useMutation({
    mutationFn: () => emailMarketingClient.createAutomation({ type: card.type, locationId }),
    onSuccess: (created) => router.push(`/dashboard/marketing/email/automations/${created.id}`),
  });
  const toggle = useMutation({
    mutationFn: (on: boolean) => emailMarketingClient.setAutomationEnabled(a!.id, on),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-mkt", "automations"] }),
  });
  const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: a?.stats.currency || "GBP" });
  const rate = (n: number) => (a?.stats.sent ? `${Math.round((n / a.stats.sent) * 100)}%` : "—");

  return (
    <div className={cn("flex flex-col rounded-2xl border bg-white p-5", a?.enabled ? "border-emerald-300" : "border-zinc-200")}>
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-bold text-zinc-900">{card.name}</h3>
            {a && (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
                  a.enabled ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-600",
                )}
              >
                {a.enabled ? "On" : "Off"}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-zinc-500">{card.description}</p>
        </div>
        {a && (
          <button
            role="switch"
            aria-checked={a.enabled}
            aria-label={a.enabled ? "Switch off" : "Switch on"}
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(!a.enabled)}
            className={cn(
              "relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-60",
              a.enabled ? "bg-emerald-500" : "bg-zinc-300",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
                a.enabled ? "left-[22px]" : "left-0.5",
              )}
            />
          </button>
        )}
      </div>

      {a?.lastError && !a.enabled && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {a.lastError}
        </div>
      )}
      {toggle.isError && (
        <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{apiErrorMessage(toggle.error)}</div>
      )}

      {a ? (
        <>
          <div className="mt-4 grid grid-cols-4 gap-2 text-center">
            {[
              ["Sent", a.stats.sent.toLocaleString()],
              ["Opened", rate(a.stats.opened)],
              ["Orders", a.stats.orders.toLocaleString()],
              ["Sales", money.format(a.stats.revenue)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-zinc-50 px-2 py-2">
                <div className="text-sm font-bold tabular-nums text-zinc-900">{value}</div>
                <div className="text-[11px] text-zinc-500">{label}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 text-xs text-zinc-500">
            {card.type === "WIN_BACK"
              ? `Sends after ${a.settings.days ?? 45} days without an order.`
              : `Sends ${a.settings.delayHours ? `${a.settings.delayHours}h` : "soon"} after someone subscribes.`}
          </div>
          <Link
            href={`/dashboard/marketing/email/automations/${a.id}`}
            className="mt-4 inline-flex items-center gap-1 self-start text-sm font-semibold text-indigo-700 hover:text-indigo-900"
          >
            Edit email &amp; settings <ArrowRight className="h-4 w-4" />
          </Link>
        </>
      ) : (
        <button
          onClick={() => setup.mutate()}
          disabled={setup.isPending}
          className="mt-5 inline-flex items-center justify-center gap-1.5 self-start rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {setup.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Set up
        </button>
      )}
      {setup.isError && <p className="mt-2 text-xs text-rose-600">{apiErrorMessage(setup.error)}</p>}
    </div>
  );
}
