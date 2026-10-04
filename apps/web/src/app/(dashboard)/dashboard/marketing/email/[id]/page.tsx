"use client";

// One email campaign: the editor while it's a draft (or scheduled), the
// report once it has gone out.

import { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  Check,
  CheckCircle2,
  Copy,
  Eye,
  FlaskConical,
  Loader2,
  MousePointerClick,
  PencilLine,
  PoundSterling,
  Send,
  ShoppingBag,
  Trash2,
  UserMinus,
  Users,
  X,
} from "lucide-react";
import { EMAIL_SEGMENTS, type EmailAudience, type EmailDesign } from "@orderhub/shared";
import {
  apiErrorMessage,
  emailMarketingClient,
  formatMinor,
  type EmailCampaign,
  type EmailMarketingContext,
} from "@/lib/api/email-marketing.client";
import { BlockEditor } from "@/components/email-marketing/block-editor";
import { EmailPreview } from "@/components/email-marketing/email-preview";
import { EmailStatusBadge } from "@/components/email-marketing/status-badge";
import { cn } from "@/lib/utils";

interface Props {
  params: Promise<{ id: string }>;
}

export default function EmailCampaignPage({ params }: Props) {
  const { id } = use(params);
  const { data: ctx } = useQuery({ queryKey: ["email-mkt", "context"], queryFn: emailMarketingClient.context });
  const { data: campaign, isLoading, error } = useQuery({
    queryKey: ["email-mkt", "campaign", id],
    queryFn: () => emailMarketingClient.campaign(id),
    refetchInterval: (q) => ((q.state.data as EmailCampaign | undefined)?.status === "SENDING" ? 4000 : false),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-24 text-zinc-400">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (error || !campaign) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <p className="text-sm text-zinc-600">{apiErrorMessage(error, "Campaign not found")}</p>
        <Link href="/dashboard/marketing/email" className="mt-3 inline-block text-sm font-medium text-indigo-700">
          Back to campaigns
        </Link>
      </div>
    );
  }
  const editable = campaign.status === "DRAFT" || campaign.status === "SCHEDULED";
  return editable ? (
    <Editor key={campaign.id} campaign={campaign} ctx={ctx} />
  ) : (
    <Report campaign={campaign} ctx={ctx} />
  );
}

/* ─────────────────────────── Editor ─────────────────────────── */

type Draft = Pick<EmailCampaign, "name" | "subject" | "preheader" | "fromName" | "replyTo" | "design" | "audience" | "brandId">;

function Editor({ campaign, ctx }: { campaign: EmailCampaign; ctx?: EmailMarketingContext }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => ({
    name: campaign.name,
    subject: campaign.subject,
    preheader: campaign.preheader,
    fromName: campaign.fromName,
    replyTo: campaign.replyTo,
    design: campaign.design?.blocks ? campaign.design : { theme: campaign.design?.theme as any, blocks: [] },
    audience: campaign.audience?.segment ? campaign.audience : { segment: "ALL" },
    brandId: campaign.brandId,
  }));
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [modal, setModal] = useState<null | "test" | "send" | "schedule">(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: (d: Draft) =>
      emailMarketingClient.update(campaign.id, {
        name: d.name,
        subject: d.subject,
        preheader: d.preheader,
        fromName: d.fromName,
        replyTo: d.replyTo || null,
        design: d.design,
        audience: d.audience,
        brandId: d.brandId,
      }),
    onSuccess: () => {
      setSaveError(null);
      qc.invalidateQueries({ queryKey: ["email-mkt", "campaigns"] });
    },
    onError: (e) => setSaveError(apiErrorMessage(e, "Couldn't save")),
  });

  // Autosave, debounced. Saving the whole draft each time keeps it simple and
  // means the last write always wins with the latest state.
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

  /** Save pending edits before a modal reads the campaign. Never throws: a
   *  failed save shows its error on the page, and the modal still opens so
   *  the button never looks dead. */
  const flush = async () => {
    if (dirty || save.isPending) {
      setDirty(false);
      await save.mutateAsync(latest.current).catch(() => undefined);
    }
  };

  const brand = ctx?.brands.find((b) => b.id === draft.brandId) ?? null;
  const brandName = draft.fromName || brand?.name || "Your restaurant";

  const remove = useMutation({
    mutationFn: () => emailMarketingClient.remove(campaign.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["email-mkt", "campaigns"] });
      router.push("/dashboard/marketing/email");
    },
  });
  const unschedule = useMutation({
    mutationFn: () => emailMarketingClient.cancel(campaign.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-mkt"] }),
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/dashboard/marketing/email"
          className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100"
          aria-label="Back to campaigns"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <input
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
          aria-label="Campaign name"
          className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-lg font-bold text-zinc-900 hover:border-zinc-200 focus:border-indigo-400 focus:outline-none"
        />
        <EmailStatusBadge status={campaign.status} />
        <span className="w-20 text-xs text-zinc-400" aria-live="polite">
          {save.isPending ? "Saving…" : dirty ? "" : saveError ? "" : "Saved"}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={async () => {
              await flush();
              setModal("test");
            }}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            <FlaskConical className="h-4 w-4" /> Send test
          </button>
          <button
            onClick={async () => {
              await flush();
              setModal("schedule");
            }}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            <CalendarClock className="h-4 w-4" /> Schedule
          </button>
          <button
            onClick={async () => {
              await flush();
              setModal("send");
            }}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
          >
            <Send className="h-4 w-4" /> Send
          </button>
        </div>
      </div>

      {saveError && <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{saveError}</div>}
      {campaign.lastError && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {campaign.lastError}
        </div>
      )}
      {campaign.status === "SCHEDULED" && campaign.scheduledAt && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
          <CalendarClock className="h-4 w-4" />
          Scheduled for{" "}
          <b>{new Date(campaign.scheduledAt).toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" })}</b>.
          Edits are saved and will be sent.
          <button
            onClick={() => unschedule.mutate()}
            className="ml-auto text-xs font-semibold text-sky-800 underline"
            disabled={unschedule.isPending}
          >
            Unschedule
          </button>
        </div>
      )}

      {/* Mobile switch */}
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
          <Section title="Who it's from and the subject line">
            <div className="grid gap-3 sm:grid-cols-2">
              {ctx && ctx.brands.length > 1 && (
                <Labeled label="Brand">
                  <select
                    value={draft.brandId ?? ""}
                    onChange={(e) => {
                      const b = ctx.brands.find((x) => x.id === e.target.value);
                      setDraft((d) => ({ ...d, brandId: e.target.value || null, fromName: b?.name ?? d.fromName }));
                      setDirty(true);
                    }}
                    className={inputCls}
                  >
                    {ctx.brands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </Labeled>
              )}
              <Labeled label="Sender name">
                <input
                  value={draft.fromName ?? ""}
                  onChange={(e) => set("fromName", e.target.value)}
                  placeholder={brand?.name ?? "Your restaurant"}
                  className={inputCls}
                />
              </Labeled>
              <Labeled label="Replies go to (optional)">
                <input
                  value={draft.replyTo ?? ""}
                  onChange={(e) => set("replyTo", e.target.value)}
                  placeholder="hello@yourrestaurant.com"
                  type="email"
                  className={inputCls}
                />
              </Labeled>
            </div>
            <Labeled label="Subject line" hint={`${draft.subject.length}/60 · short subjects get opened more`}>
              <div className="flex gap-2">
                <input
                  value={draft.subject}
                  onChange={(e) => set("subject", e.target.value)}
                  placeholder="20% off this weekend 🎉"
                  className={inputCls}
                />
                <button
                  onClick={() => set("subject", `${draft.subject}{{first_name}}`)}
                  className="shrink-0 rounded-lg border border-zinc-200 px-2.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
                  title="Insert the customer's first name"
                >
                  + Name
                </button>
              </div>
            </Labeled>
            <Labeled label="Preview text" hint="The grey line inboxes show after the subject.">
              <input
                value={draft.preheader ?? ""}
                onChange={(e) => set("preheader", e.target.value)}
                className={inputCls}
              />
            </Labeled>
          </Section>

          <Section title="Who gets it">
            <AudiencePicker
              audience={draft.audience}
              onChange={(a) => set("audience", a)}
              brands={ctx?.brands ?? []}
              campaignId={campaign.id}
              locationId={campaign.locationId}
            />
          </Section>

          <Section title="Content">
            <BlockEditor
              design={draft.design}
              onChange={(d: EmailDesign) => set("design", d)}
              brandId={draft.brandId}
              locationId={campaign.locationId}
            />
          </Section>

          {!campaign.startedAt && (
            <button
              onClick={() => {
                if (confirm("Delete this draft?")) remove.mutate();
              }}
              className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-rose-600"
            >
              <Trash2 className="h-4 w-4" /> Delete draft
            </button>
          )}
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

      {modal === "test" && <TestModal campaignId={campaign.id} onClose={() => setModal(null)} />}
      {modal === "send" && <SendModal campaign={campaign} ctx={ctx} onClose={() => setModal(null)} />}
      {modal === "schedule" && <ScheduleModal campaign={campaign} onClose={() => setModal(null)} />}
    </div>
  );
}

const inputCls = "w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-zinc-400">{hint}</span>}
    </label>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function AudiencePicker({
  audience,
  onChange,
  brands,
  campaignId,
  locationId,
}: {
  audience: EmailAudience;
  onChange: (a: EmailAudience) => void;
  brands: EmailMarketingContext["brands"];
  campaignId: string;
  locationId: string | null;
}) {
  const debounced = useDebounced(audience, 400);
  const { data: est, isFetching } = useQuery({
    queryKey: ["email-mkt", "estimate", campaignId, debounced, locationId],
    queryFn: () => emailMarketingClient.estimate({ campaignId, audience: debounced, locationId }),
  });
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {EMAIL_SEGMENTS.map((s) => {
          const on = audience.segment === s.id;
          return (
            <button
              key={s.id}
              onClick={() =>
                onChange({
                  segment: s.id,
                  brandId: audience.brandId,
                  ...(s.param ? { [s.param]: (audience as any)[s.param] ?? s.defaultValue } : {}),
                })
              }
              className={cn(
                "rounded-xl border px-3 py-2.5 text-left transition",
                on ? "border-indigo-500 bg-indigo-50/60 ring-1 ring-indigo-500" : "border-zinc-200 bg-white hover:border-zinc-300",
              )}
            >
              <div className="text-sm font-semibold text-zinc-900">{s.label}</div>
              <div className="text-xs text-zinc-500">{s.hint}</div>
              {on && s.param && (
                <div className="mt-2 flex items-center gap-2 text-xs text-zinc-600" onClick={(e) => e.stopPropagation()}>
                  {s.param === "minSpend" ? "At least" : s.param === "minOrders" ? "At least" : "N ="}
                  <input
                    type="number"
                    min={1}
                    value={(audience as any)[s.param] ?? s.defaultValue}
                    onChange={(e) => onChange({ ...audience, [s.param!]: Number(e.target.value) })}
                    className="w-20 rounded-md border border-zinc-200 px-2 py-1 text-sm"
                  />
                  {s.param === "days" ? "days" : s.param === "minOrders" ? "orders" : "spent"}
                </div>
              )}
            </button>
          );
        })}
      </div>
      {brands.length > 1 && (
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          Only people who ordered from
          <select
            value={audience.brandId ?? ""}
            onChange={(e) => onChange({ ...audience, brandId: e.target.value || null })}
            className="rounded-lg border border-zinc-200 px-2 py-1 text-sm"
          >
            <option value="">any brand</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl bg-zinc-50 px-4 py-3 text-sm">
        <span className="flex items-center gap-1.5 font-semibold text-zinc-900">
          <Users className="h-4 w-4 text-indigo-600" />
          {est ? `${est.recipients.toLocaleString()} subscriber${est.recipients === 1 ? "" : "s"}` : "…"}
          {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
        </span>
        {est && (
          <span className="text-zinc-600">
            {est.costMinor === 0 ? "Free" : `${formatMinor(est.costMinor, est.currency)}`}
            {est.free > 0 && est.billable > 0 && ` (${est.free.toLocaleString()} free)`}
          </span>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── Modals ─────────────────────────── */

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-base font-bold text-zinc-900">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-5">{children}</div>
      </div>
    </div>
  );
}

function TestModal({ campaignId, onClose }: { campaignId: string; onClose: () => void }) {
  const [to, setTo] = useState("");
  const send = useMutation({ mutationFn: () => emailMarketingClient.test(campaignId, to.split(/[,\s]+/).filter(Boolean)) });
  return (
    <Modal title="Send a test email" onClose={onClose}>
      {send.isSuccess ? (
        <div className="flex items-center gap-2 text-sm text-emerald-700">
          <CheckCircle2 className="h-5 w-5" /> Sent to {send.data.sentTo.join(", ")}. Check your inbox (and spam folder).
        </div>
      ) : (
        <>
          <p className="text-sm text-zinc-600">See exactly what your customers will get. Tests are free.</p>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="you@example.com"
            type="email"
            autoFocus
            className={inputCls}
          />
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
    </Modal>
  );
}

function SendModal({ campaign, ctx, onClose }: { campaign: EmailCampaign; ctx?: EmailMarketingContext; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: est, isLoading } = useQuery({
    queryKey: ["email-mkt", "estimate", "send", campaign.id],
    queryFn: () => emailMarketingClient.estimate({ campaignId: campaign.id }),
  });
  const send = useMutation({
    mutationFn: () => emailMarketingClient.send(campaign.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-mkt"] }),
  });
  const blocked = !est || est.recipients === 0 || !est.canAfford || !est.enabled || !campaign.subject.trim();
  return (
    <Modal title="Send this campaign" onClose={onClose}>
      {isLoading || !est ? (
        <div className="flex justify-center py-6 text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : send.isSuccess ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-emerald-700">
            <CheckCircle2 className="h-5 w-5" />
            <span className="font-semibold">On its way to {send.data.recipients.toLocaleString()} customers</span>
          </div>
          <p className="text-sm text-zinc-600">Results (opens, clicks and orders) appear on this page as they come in.</p>
          <button onClick={onClose} className="w-full rounded-lg bg-indigo-600 py-2 text-sm font-semibold text-white">
            See results
          </button>
        </div>
      ) : (
        <>
          <dl className="space-y-2 text-sm">
            <Row label="Subject" value={campaign.subject || "—"} />
            <Row label="Recipients" value={`${est.recipients.toLocaleString()} subscribers`} />
            {est.free > 0 && <Row label="From your free allowance" value={est.free.toLocaleString()} />}
            <Row
              label="Cost"
              value={
                est.costMinor === 0
                  ? "Free"
                  : `${formatMinor(est.costMinor, est.currency)} (${est.billable.toLocaleString()} × ${formatMinor(est.pricePer1000Minor, est.currency)}/1,000)`
              }
              strong
            />
            {est.costMinor > 0 && <Row label="Wallet balance" value={formatMinor(est.balanceMinor, est.currency)} />}
          </dl>
          {!est.enabled && (
            <Warn>Sending isn&apos;t switched on for your account yet. Contact support to enable email marketing.</Warn>
          )}
          {est.recipients === 0 && <Warn>Nobody matches this audience yet.</Warn>}
          {!est.canAfford && (
            <Warn>
              Your wallet needs topping up first.{" "}
              <Link href="/dashboard/wallet" className="font-semibold underline">
                Top up
              </Link>
            </Warn>
          )}
          {!campaign.subject.trim() && <Warn>Add a subject line first.</Warn>}
          {send.isError && <Warn>{apiErrorMessage(send.error)}</Warn>}
          <p className="text-xs text-zinc-500">
            Once sent, an email can&apos;t be recalled. Anything that fails to send is refunded to your wallet.
          </p>
          <button
            onClick={() => send.mutate()}
            disabled={blocked || send.isPending}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send to {est.recipients.toLocaleString()} now
          </button>
          {ctx?.fromAddress && <p className="text-center text-[11px] text-zinc-400">Sent from {ctx.fromAddress}</p>}
        </>
      )}
    </Modal>
  );
}

function ScheduleModal({ campaign, onClose }: { campaign: EmailCampaign; onClose: () => void }) {
  const qc = useQueryClient();
  const initial = useMemo(() => {
    const d = new Date(Date.now() + 86400_000);
    d.setHours(11, 0, 0, 0);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, []);
  const [at, setAt] = useState(initial);
  const schedule = useMutation({
    mutationFn: () => emailMarketingClient.schedule(campaign.id, new Date(at).toISOString()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["email-mkt"] });
      onClose();
    },
  });
  return (
    <Modal title="Schedule for later" onClose={onClose}>
      <p className="text-sm text-zinc-600">
        Lunch (11am) and early evening (5pm) are when hungry people open emails. The audience and cost are worked out
        at the moment it sends, and your wallet is charged then.
      </p>
      <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className={inputCls} />
      {schedule.isError && <Warn>{apiErrorMessage(schedule.error)}</Warn>}
      <button
        onClick={() => schedule.mutate()}
        disabled={schedule.isPending || !at}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
      >
        {schedule.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />} Schedule
      </button>
    </Modal>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-zinc-500">{label}</dt>
      <dd className={cn("text-right text-zinc-900", strong && "font-semibold")}>{value}</dd>
    </div>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/* ─────────────────────────── Report ─────────────────────────── */

function Report({ campaign: c, ctx }: { campaign: EmailCampaign; ctx?: EmailMarketingContext }) {
  const qc = useQueryClient();
  const router = useRouter();
  const brand = ctx?.brands.find((b) => b.id === c.brandId) ?? null;
  const dup = useMutation({
    mutationFn: () => emailMarketingClient.duplicate(c.id),
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: ["email-mkt", "campaigns"] });
      router.push(`/dashboard/marketing/email/${n.id}`);
    },
  });
  const cancel = useMutation({
    mutationFn: () => emailMarketingClient.cancel(c.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-mkt"] }),
  });
  // Failed or stopped before anything went out (a refused API key, an
  // unverified domain): fix the cause and send it again, or throw it away.
  const nothingSent =
    (c.status === "FAILED" || c.status === "CANCELLED") && c.sentCount === 0 && (!!c.completedAt || !c.startedAt);
  const retry = useMutation({
    mutationFn: () => emailMarketingClient.retry(c.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-mkt"] }),
  });
  const remove = useMutation({
    mutationFn: () => emailMarketingClient.remove(c.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["email-mkt", "campaigns"] });
      router.push("/dashboard/marketing/email");
    },
  });
  const base = c.sentCount || 0;
  const rate = (n: number) => (base ? `${((n / base) * 100).toFixed(1)}%` : "—");
  const progress = c.recipientCount ? Math.round(((c.sentCount + c.failedCount + c.skippedCount) / c.recipientCount) * 100) : 0;
  const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: c.results.currency || "GBP" });

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/dashboard/marketing/email" className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold text-zinc-900">{c.name}</h1>
          <p className="truncate text-sm text-zinc-500">
            {c.subject}
            {c.startedAt && ` · ${new Date(c.startedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`}
          </p>
        </div>
        <EmailStatusBadge status={c.status} />
        {c.status === "SENDING" && (
          <button
            onClick={() => {
              if (confirm("Stop sending? Emails already sent can't be recalled; the rest are refunded.")) cancel.mutate();
            }}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Stop sending
          </button>
        )}
        {nothingSent && (
          <>
            <button
              onClick={() => retry.mutate()}
              disabled={retry.isPending}
              className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {retry.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PencilLine className="h-4 w-4" />}
              Edit &amp; try again
            </button>
            <button
              onClick={() => {
                if (confirm("Delete this campaign? Nothing was sent, so nothing is lost.")) remove.mutate();
              }}
              disabled={remove.isPending}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 hover:text-rose-600"
            >
              <Trash2 className="h-4 w-4" /> Delete
            </button>
          </>
        )}
        <button
          onClick={() => dup.mutate()}
          disabled={dup.isPending}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          <Copy className="h-4 w-4" /> Duplicate
        </button>
      </div>

      {c.status === "SENDING" && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex justify-between text-sm text-amber-900">
            <span className="flex items-center gap-1.5 font-medium">
              <Loader2 className="h-4 w-4 animate-spin" /> Sending…
            </span>
            <span className="tabular-nums">
              {c.sentCount.toLocaleString()} / {c.recipientCount.toLocaleString()}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-amber-100">
            <div className="h-full bg-amber-500 transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
      {c.lastError && c.status !== "SENT" && (
        <div className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{c.lastError}</div>
      )}
      {(retry.isError || remove.isError) && (
        <div className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {apiErrorMessage(retry.error ?? remove.error)}
        </div>
      )}

      {/* The headline: did it make money? */}
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={ShoppingBag} label="Orders from this email" value={c.results.orders.toLocaleString()} accent />
        <Kpi icon={PoundSterling} label="Sales from this email" value={money.format(c.results.revenue)} accent />
        <Kpi icon={Eye} label="Opened" value={rate(c.openCount)} sub={`${c.openCount.toLocaleString()} people`} />
        <Kpi icon={MousePointerClick} label="Clicked" value={rate(c.clickCount)} sub={`${c.clickCount.toLocaleString()} people`} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Mini label="Sent" value={c.sentCount} />
        <Mini label="Delivered" value={c.deliveredCount} />
        <Mini label="Unsubscribed" value={c.unsubscribeCount} icon={UserMinus} />
        <Mini label="Bounced" value={c.bounceCount} />
        <Mini label="Spam reports" value={c.complaintCount} />
        <Mini label="Not sent" value={c.failedCount + c.skippedCount} />
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Orders count when a customer clicks through and orders online within 14 days. Some inboxes (Apple Mail) open
        emails automatically, so open rates run high; clicks and orders are the numbers to trust.
        {c.chargedMinor > 0 &&
          ` Charged ${formatMinor(c.chargedMinor - c.refundedMinor)}${c.refundedMinor ? ` (${formatMinor(c.refundedMinor)} refunded)` : ""}.`}
      </p>

      <div className="mt-6 max-w-2xl">
        <EmailPreview
          design={c.design}
          brandName={c.fromName || brand?.name || "Your restaurant"}
          logoUrl={brand?.logoUrl}
          subject={c.subject}
          preheader={c.preheader}
        />
      </div>
    </div>
  );
}

function Kpi(props: { icon: any; label: string; value: string; sub?: string; accent?: boolean }) {
  const Icon = props.icon;
  return (
    <div className={cn("rounded-xl border px-4 py-3", props.accent ? "border-indigo-200 bg-indigo-50/60" : "border-zinc-200 bg-white")}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
        <Icon className={cn("h-4 w-4", props.accent ? "text-indigo-600" : "text-zinc-400")} /> {props.label}
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-zinc-900">{props.value}</div>
      {props.sub && <div className="text-xs text-zinc-500">{props.sub}</div>}
    </div>
  );
}

function Mini({ label, value, icon: Icon = Check }: { label: string; value: number; icon?: any }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
      <div className="flex items-center gap-1 text-[11px] text-zinc-500">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className="text-base font-semibold tabular-nums text-zinc-900">{value.toLocaleString()}</div>
    </div>
  );
}
