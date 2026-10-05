"use client";

// One automatic email (welcome or win-back): when it sends, what it says, and
// the switch. Same editor and live preview as a campaign.

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, CheckCircle2, Eye, FlaskConical, Loader2, PencilLine, Users, X } from "lucide-react";
import { AUTOMATION_INFO, type EmailAutomationSettings, type EmailDesign } from "@orderhub/shared";
import { apiErrorMessage, emailMarketingClient, type EmailAutomation } from "@/lib/api/email-marketing.client";
import { BlockEditor } from "@/components/email-marketing/block-editor";
import { EmailPreview } from "@/components/email-marketing/email-preview";
import { cn } from "@/lib/utils";

interface Props {
  params: Promise<{ id: string }>;
}

export default function AutomationPage({ params }: Props) {
  const { id } = use(params);
  const { data: a, isLoading, error } = useQuery({
    queryKey: ["email-mkt", "automation", id],
    queryFn: () => emailMarketingClient.automation(id),
  });
  if (isLoading) {
    return (
      <div className="flex justify-center py-24 text-zinc-400">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (error || !a) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <p className="text-sm text-zinc-600">{apiErrorMessage(error, "Automation not found")}</p>
        <Link href="/dashboard/marketing/email" className="mt-3 inline-block text-sm font-medium text-indigo-700">
          Back to email marketing
        </Link>
      </div>
    );
  }
  return <Editor key={a.id} a={a} />;
}

type Draft = Pick<EmailAutomation, "subject" | "preheader" | "fromName" | "replyTo" | "design" | "settings" | "brandId">;

const inputCls = "w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none";

function Editor({ a }: { a: EmailAutomation }) {
  const qc = useQueryClient();
  const info = AUTOMATION_INFO[a.type];
  const { data: ctx } = useQuery({
    queryKey: ["email-mkt", "context", a.locationId],
    queryFn: () => emailMarketingClient.context(a.locationId),
  });
  const [draft, setDraft] = useState<Draft>({
    subject: a.subject,
    preheader: a.preheader,
    fromName: a.fromName,
    replyTo: a.replyTo,
    design: a.design,
    settings: a.settings,
    brandId: a.brandId,
  });
  const [dirty, setDirty] = useState(false);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [testing, setTesting] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: (d: Draft) => emailMarketingClient.updateAutomation(a.id, { ...d, replyTo: d.replyTo || null }),
    onSuccess: (saved) => {
      // An edit that breaks a running automation (e.g. removes its code)
      // pauses it server-side — reflect that straight away.
      qc.setQueryData(["email-mkt", "automation", a.id], (old: any) => ({ ...old, ...saved }));
      qc.invalidateQueries({ queryKey: ["email-mkt", "automations"] });
    },
  });
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      setDirty(false);
      save.mutate(latest.current);
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, dirty]);
  const flush = async () => {
    if (dirty || save.isPending) {
      setDirty(false);
      await save.mutateAsync(latest.current).catch(() => undefined);
    }
  };

  const { data: live } = useQuery({
    queryKey: ["email-mkt", "automation", a.id],
    queryFn: () => emailMarketingClient.automation(a.id),
    initialData: a,
  });
  const enabled = live?.enabled ?? a.enabled;
  const toggle = useMutation({
    mutationFn: async (on: boolean) => {
      await flush();
      return emailMarketingClient.setAutomationEnabled(a.id, on);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-mkt"] }),
  });

  const brand = ctx?.brands.find((b) => b.id === draft.brandId) ?? null;
  const brandName = draft.fromName || brand?.name || "Your restaurant";
  const s = draft.settings ?? {};
  const setSetting = (k: keyof EmailAutomationSettings, v: number) => set("settings", { ...s, [k]: v });
  const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: live?.stats.currency || "GBP" });

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/dashboard/marketing/email" className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold text-zinc-900">{info.name}</h1>
          <p className="text-sm text-zinc-500">{info.description}</p>
        </div>
        <span className="w-16 text-xs text-zinc-400" aria-live="polite">
          {save.isPending ? "Saving…" : dirty ? "" : "Saved"}
        </span>
        <button
          onClick={async () => {
            await flush();
            setTesting(true);
          }}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          <FlaskConical className="h-4 w-4" /> Send test
        </button>
        <button
          onClick={() => toggle.mutate(!enabled)}
          disabled={toggle.isPending}
          className={cn(
            "flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold shadow-sm disabled:opacity-60",
            enabled ? "bg-emerald-600 text-white hover:bg-emerald-700" : "bg-indigo-600 text-white hover:bg-indigo-700",
          )}
        >
          {toggle.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : enabled ? <CheckCircle2 className="h-4 w-4" /> : null}
          {enabled ? "On — click to switch off" : "Switch on"}
        </button>
      </div>

      {(toggle.isError || save.isError) && (
        <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {apiErrorMessage(toggle.error ?? save.error)}
        </div>
      )}
      {live?.lastError && !enabled && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {live.lastError}
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[
          ["Sent", (live?.stats.sent ?? 0).toLocaleString()],
          ["Opened", (live?.stats.opened ?? 0).toLocaleString()],
          ["Clicked", (live?.stats.clicked ?? 0).toLocaleString()],
          ["Orders", (live?.stats.orders ?? 0).toLocaleString()],
          ["Sales", money.format(live?.stats.revenue ?? 0)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-zinc-200 bg-white px-3 py-2">
            <div className="text-[11px] text-zinc-500">{label}</div>
            <div className="text-lg font-bold tabular-nums text-zinc-900">{value}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex rounded-lg bg-zinc-100 p-1 lg:hidden">
        {(
          [
            ["edit", "Edit", PencilLine],
            ["preview", "Preview", Eye],
          ] as const
        ).map(([v, label, Icon]) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium text-zinc-600",
              view === v && "bg-white text-zinc-900 shadow-sm",
            )}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className={cn("space-y-6", view === "preview" && "hidden lg:block")}>
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">When it sends</h2>
            <div className="rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-700">
              {a.type === "WIN_BACK" ? (
                <div className="space-y-3">
                  <label className="flex flex-wrap items-center gap-2">
                    Email a customer when they haven&apos;t ordered from this shop for
                    <input
                      type="number"
                      min={7}
                      max={365}
                      value={s.days ?? 45}
                      onChange={(e) => setSetting("days", Number(e.target.value))}
                      className="w-20 rounded-md border border-zinc-200 px-2 py-1"
                    />
                    days.
                  </label>
                  <label className="flex flex-wrap items-center gap-2">
                    Never send the same person this more than once every
                    <input
                      type="number"
                      min={14}
                      max={365}
                      value={s.cooldownDays ?? 90}
                      onChange={(e) => setSetting("cooldownDays", Number(e.target.value))}
                      className="w-20 rounded-md border border-zinc-200 px-2 py-1"
                    />
                    days.
                  </label>
                  <p className="text-xs text-zinc-500">
                    Customers who last ordered over a year ago aren&apos;t emailed — at that point it&apos;s spam, not a
                    nudge.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <label className="flex flex-wrap items-center gap-2">
                    Send
                    <input
                      type="number"
                      min={0}
                      max={72}
                      value={s.delayHours ?? 1}
                      onChange={(e) => setSetting("delayHours", Number(e.target.value))}
                      className="w-20 rounded-md border border-zinc-200 px-2 py-1"
                    />
                    hours after someone subscribes. Once per person, ever.
                  </label>
                  <p className="text-xs text-zinc-500">
                    Switching it on greets people who join from then on. It never emails your existing list.
                  </p>
                </div>
              )}
              <p className="mt-3 flex items-center gap-1.5 border-t border-zinc-100 pt-3 text-xs text-zinc-600">
                <Users className="h-3.5 w-3.5 text-indigo-600" />
                {live?.dueNow != null
                  ? `${live.dueNow.toLocaleString()} ${live.dueNow === 1 ? "person is" : "people are"} due right now${enabled ? " — they'll get it at the next run (10am–8pm)" : " — they'd get it once you switch on"}.`
                  : "Checking who's due…"}
              </p>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Who it&apos;s from and the subject line</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-zinc-600">Sender name</span>
                <input value={draft.fromName ?? ""} onChange={(e) => set("fromName", e.target.value)} className={inputCls} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-zinc-600">Replies go to (optional)</span>
                <input value={draft.replyTo ?? ""} onChange={(e) => set("replyTo", e.target.value)} type="email" className={inputCls} />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-zinc-600">Subject line</span>
              <input value={draft.subject} onChange={(e) => set("subject", e.target.value)} className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-zinc-600">Preview text</span>
              <input value={draft.preheader ?? ""} onChange={(e) => set("preheader", e.target.value)} className={inputCls} />
            </label>
          </section>

          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Content</h2>
            <p className="text-xs text-zinc-500">
              Use a code without an expiry date here: this email keeps sending for months. One use per customer keeps
              it fair.
            </p>
            <BlockEditor
              design={draft.design}
              onChange={(d: EmailDesign) => set("design", d)}
              brandId={draft.brandId}
              locationId={a.locationId}
              offerCodeExpiryDays={null}
            />
          </section>
        </div>

        <div className={cn(view === "edit" && "hidden lg:block")}>
          <div className="lg:sticky lg:top-4">
            <EmailPreview
              design={draft.design}
              brandName={brandName}
              logoUrl={brand?.logoUrl}
              subject={draft.subject}
              preheader={draft.preheader}
            />
          </div>
        </div>
      </div>

      {testing && <TestModal id={a.id} onClose={() => setTesting(false)} />}
    </div>
  );
}

function TestModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [to, setTo] = useState("");
  const send = useMutation({ mutationFn: () => emailMarketingClient.testAutomation(id, to.split(/[,\s]+/).filter(Boolean)) });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-base font-bold text-zinc-900">Send a test email</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          {send.isSuccess ? (
            <p className="flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle2 className="h-5 w-5" /> Sent to {send.data.sentTo.join(", ")}.
            </p>
          ) : (
            <>
              <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" type="email" autoFocus className={inputCls} />
              {send.isError && <p className="text-sm text-rose-600">{apiErrorMessage(send.error)}</p>}
              <button
                onClick={() => send.mutate()}
                disabled={!to.trim() || send.isPending}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />} Send test
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
