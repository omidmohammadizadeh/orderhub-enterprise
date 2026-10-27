"use client";

// Console → Push & email: offers sent to Eat For Less customers who said yes
// to them. Write once, see it as the customer will, test it on yourself, send.
// Only drafts can be changed; a sent campaign is a record.

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Loader2, Mail, Pencil, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import {
  eflAdminClient,
  type EflCampaign,
  type EflCampaignChannel,
  type EflCampaignInput,
} from "@/lib/api/efl.client";
import { EflMark } from "./console-shell";
import { apiErrorMessage } from "./format";

const PUSH_TITLE_MAX = 60;
const PUSH_BODY_MAX = 180;

const QUERY_KEY = ["efl-admin", "campaigns"] as const;

type Draft = { channel: EflCampaignChannel; title: string; body: string; ctaLabel: string; ctaUrl: string };

const EMPTY: Draft = { channel: "PUSH", title: "", body: "", ctaLabel: "", ctaUrl: "" };

const STATUS: Record<EflCampaign["status"], { text: string; cls: string }> = {
  DRAFT: { text: "Draft", cls: "bg-zinc-100 text-zinc-700" },
  SENDING: { text: "Sending", cls: "bg-[#0B0B0B] text-white" },
  SENT: { text: "Sent", cls: "bg-[#D4FF3F] text-[#0B0B0B]" },
  FAILED: { text: "Failed", cls: "bg-red-50 text-red-700" },
};

const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** What's wrong with the draft in plain words, or null when it can be saved. */
function problemWith(d: Draft): string | null {
  const title = d.title.trim();
  const body = d.body.trim();
  if (!title) return d.channel === "PUSH" ? "Add a title." : "Add a subject.";
  if (!body) return "Add a message.";
  if (d.channel === "PUSH") {
    if (title.length > PUSH_TITLE_MAX) return `Keep the title to ${PUSH_TITLE_MAX} characters.`;
    if (body.length > PUSH_BODY_MAX) return `Keep the message to ${PUSH_BODY_MAX} characters.`;
    return null;
  }
  const label = d.ctaLabel.trim();
  const url = d.ctaUrl.trim();
  if (!!label !== !!url) return "A button needs both a label and a link.";
  if (url && !/^https:\/\/[^\s]+\.[^\s]+/i.test(url)) return "The button link must start with https://";
  return null;
}

function toInput(d: Draft): EflCampaignInput {
  const email = d.channel === "EMAIL";
  return {
    channel: d.channel,
    title: d.title.trim(),
    body: d.body.trim(),
    ctaLabel: email && d.ctaLabel.trim() ? d.ctaLabel.trim() : null,
    ctaUrl: email && d.ctaUrl.trim() ? d.ctaUrl.trim() : null,
  };
}

export function ConsoleCampaigns() {
  const qc = useQueryClient();
  const campaigns = useQuery({
    queryKey: QUERY_KEY,
    queryFn: eflAdminClient.campaigns,
    // Watch a send finish; stop asking once nothing is on its way out.
    refetchInterval: (q) => (q.state.data?.campaigns.some((c) => c.status === "SENDING") ? 5_000 : false),
  });

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | "send" | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const composerRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const audience = campaigns.data?.audience;
  const reach = audience ? (draft.channel === "PUSH" ? audience.push : audience.email) : null;
  const problem = problemWith(draft);
  const isPush = draft.channel === "PUSH";

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const refresh = () => qc.invalidateQueries({ queryKey: QUERY_KEY });
  const reset = () => {
    setDraft(EMPTY);
    setEditingId(null);
  };

  /** Saves the composer as a draft (new or the one being edited) and returns its id. */
  const persist = async (): Promise<string> => {
    const input = toInput(draft);
    const saved = editingId
      ? await eflAdminClient.updateCampaign(editingId, input)
      : await eflAdminClient.createCampaign(input);
    setEditingId(saved.id);
    return saved.id;
  };

  const run = async (kind: "save" | "test" | "send", fallback: string, work: () => Promise<void>) => {
    if (problem) {
      toast.error(problem);
      return;
    }
    setBusy(kind);
    try {
      await work();
    } catch (err) {
      toast.error(apiErrorMessage(err, fallback));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const onSave = () =>
    run("save", "Couldn't save the draft", async () => {
      await persist();
      toast.success("Draft saved");
    });

  const onTest = () => {
    if (problem) {
      toast.error(problem);
      return;
    }
    const to = window.prompt("Send a test email to which address?")?.trim();
    if (!to) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      toast.error("That doesn't look like an email address");
      return;
    }
    void run("test", "Couldn't send the test", async () => {
      const id = await persist();
      const r = await eflAdminClient.testCampaign(id, to);
      toast.success(`Test sent to ${r.sentTo}`);
    });
  };

  const onSend = () => {
    if (problem) {
      toast.error(problem);
      return;
    }
    if (!reach) {
      toast.error(isPush ? "No phones have said yes to offers yet" : "No one has said yes to offer emails yet");
      return;
    }
    const people = isPush
      ? `${reach.toLocaleString("en-GB")} ${reach === 1 ? "phone" : "phones"}`
      : `${reach.toLocaleString("en-GB")} ${reach === 1 ? "person" : "people"}`;
    if (!window.confirm(`Send this ${isPush ? "push notification" : "email"} to ${people} now? It can't be taken back.`)) return;
    void run("send", "Couldn't send", async () => {
      const id = await persist();
      await eflAdminClient.sendCampaign(id);
      toast.success(`Sending to ${people}`);
      reset();
    });
  };

  const onEdit = (c: EflCampaign) => {
    setEditingId(c.id);
    setDraft({ channel: c.channel, title: c.title, body: c.body, ctaLabel: c.ctaLabel ?? "", ctaUrl: c.ctaUrl ?? "" });
    composerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    titleRef.current?.focus({ preventScroll: true });
  };

  const onDelete = async (c: EflCampaign) => {
    if (!window.confirm(`Delete the draft “${c.title}”?`)) return;
    setDeleting(c.id);
    try {
      await eflAdminClient.deleteCampaign(c.id);
      toast.success("Draft deleted");
      if (editingId === c.id) reset();
      refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't delete the draft"));
    } finally {
      setDeleting(null);
    }
  };

  const list = campaigns.data?.campaigns ?? [];

  return (
    <>
      <header>
        <h1 className="text-[28px] font-extrabold tracking-tight">Push &amp; email</h1>
        <p className="mt-1 text-[13px] text-zinc-600">
          {audience ? (
            <>
              <strong className="font-bold text-[#0B0B0B] tabular-nums">{audience.push.toLocaleString("en-GB")}</strong>{" "}
              {audience.push === 1 ? "phone gets" : "phones get"} offers by push ·{" "}
              <strong className="font-bold text-[#0B0B0B] tabular-nums">{audience.email.toLocaleString("en-GB")}</strong>{" "}
              {audience.email === 1 ? "person gets" : "people get"} offers by email
            </>
          ) : (
            "Offers go only to customers who said yes to them."
          )}
        </p>
      </header>

      <section
        ref={composerRef}
        aria-labelledby="composer-title"
        className="scroll-mt-6 rounded-2xl border border-zinc-200 bg-white p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="composer-title" className="text-lg font-extrabold tracking-tight">
            {editingId ? "Edit draft" : "New campaign"}
          </h2>
          {editingId && (
            <button
              type="button"
              onClick={reset}
              className="h-9 rounded-xl px-3 text-[13px] font-semibold text-zinc-600 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0B0B0B]"
            >
              Start a new one instead
            </button>
          )}
        </div>

        <div className="mt-4 flex flex-col gap-6 lg:flex-row">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSave();
            }}
            className="flex min-w-0 flex-1 flex-col gap-4"
          >
            <div role="radiogroup" aria-label="Send by" className="flex w-fit gap-1 rounded-xl bg-[#EAEAE6] p-1">
              {(
                [
                  { key: "PUSH", label: "Push", Icon: Bell },
                  { key: "EMAIL", label: "Email", Icon: Mail },
                ] as const
              ).map(({ key, label, Icon }) => {
                const on = draft.channel === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set("channel", key)}
                    className={
                      "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0B0B0B] " +
                      (on ? "bg-white text-[#0B0B0B] shadow-sm" : "text-zinc-600 hover:text-[#0B0B0B]")
                    }
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {label}
                  </button>
                );
              })}
            </div>

            <Field
              label={isPush ? "Title" : "Subject"}
              count={isPush ? { used: draft.title.length, max: PUSH_TITLE_MAX } : undefined}
              id="campaign-title"
            >
              <input
                ref={titleRef}
                id="campaign-title"
                type="text"
                value={draft.title}
                maxLength={isPush ? PUSH_TITLE_MAX : 200}
                onChange={(e) => set("title", e.target.value)}
                placeholder={isPush ? "Free delivery tonight" : "This week's best deals near you"}
                aria-describedby={isPush ? "campaign-title-count" : undefined}
                className="h-11 w-full rounded-xl border border-zinc-300 px-3 text-[15px] outline-none focus:border-[#0B0B0B] focus:ring-2 focus:ring-zinc-900/10"
              />
            </Field>

            <Field
              label="Message"
              count={isPush ? { used: draft.body.length, max: PUSH_BODY_MAX } : undefined}
              id="campaign-body"
            >
              <textarea
                id="campaign-body"
                value={draft.body}
                maxLength={isPush ? PUSH_BODY_MAX : 5000}
                rows={isPush ? 3 : 7}
                onChange={(e) => set("body", e.target.value)}
                placeholder={
                  isPush
                    ? "Order from any shop before 9pm and the delivery's on us."
                    : "Write the email as you'd say it. New lines are kept."
                }
                aria-describedby={isPush ? "campaign-body-count" : undefined}
                className="w-full resize-y rounded-xl border border-zinc-300 px-3 py-2.5 text-[15px] outline-none focus:border-[#0B0B0B] focus:ring-2 focus:ring-zinc-900/10"
              />
            </Field>

            {!isPush && (
              <fieldset className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <legend className="mb-1.5 text-sm font-bold">
                  Button <span className="font-medium text-zinc-500">(optional)</span>
                </legend>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-zinc-600">Label</span>
                  <input
                    type="text"
                    value={draft.ctaLabel}
                    maxLength={40}
                    onChange={(e) => set("ctaLabel", e.target.value)}
                    placeholder="Order now"
                    className="h-11 w-full rounded-xl border border-zinc-300 px-3 text-[15px] outline-none focus:border-[#0B0B0B] focus:ring-2 focus:ring-zinc-900/10"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-zinc-600">Link (https only)</span>
                  <input
                    type="url"
                    inputMode="url"
                    value={draft.ctaUrl}
                    onChange={(e) => set("ctaUrl", e.target.value)}
                    placeholder="https://eatforless.co.uk"
                    className="h-11 w-full rounded-xl border border-zinc-300 px-3 text-[15px] outline-none focus:border-[#0B0B0B] focus:ring-2 focus:ring-zinc-900/10"
                  />
                </label>
              </fieldset>
            )}

            {problem && (draft.title || draft.body || draft.ctaLabel || draft.ctaUrl) && (
              <p className="text-xs font-semibold text-zinc-600" role="status">
                {problem}
              </p>
            )}

            <div className="flex flex-wrap gap-2 border-t border-zinc-100 pt-4">
              <button
                type="submit"
                disabled={!!busy}
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-zinc-300 bg-white px-4 text-sm font-semibold hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0B0B0B] disabled:opacity-50"
              >
                {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                Save draft
              </button>
              {!isPush && (
                <button
                  type="button"
                  onClick={onTest}
                  disabled={!!busy}
                  className="inline-flex h-10 items-center gap-2 rounded-xl border border-zinc-300 bg-white px-4 text-sm font-semibold hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0B0B0B] disabled:opacity-50"
                >
                  {busy === "test" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  Send me a test
                </button>
              )}
              <button
                type="button"
                onClick={onSend}
                disabled={!!busy}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#0B0B0B] px-5 text-sm font-bold text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D4FF3F] focus-visible:ring-offset-2 disabled:opacity-50 sm:ml-auto"
              >
                {busy === "send" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                Send now
                {reach != null && (
                  <span className="font-semibold text-[#D4FF3F] tabular-nums">· {reach.toLocaleString("en-GB")}</span>
                )}
              </button>
            </div>
          </form>

          <div className="lg:w-[340px] lg:shrink-0">
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.06em] text-zinc-500">Preview</p>
            {isPush ? <PushPreview draft={draft} /> : <EmailPreview draft={draft} />}
          </div>
        </div>
      </section>

      <section aria-labelledby="campaigns-title" className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white">
        <h2 id="campaigns-title" className="px-5 pt-5 text-lg font-extrabold tracking-tight">
          Campaigns
        </h2>
        {campaigns.isLoading ? (
          <p className="p-6 text-sm text-zinc-500">Loading campaigns…</p>
        ) : campaigns.isError ? (
          <p className="p-8 text-center text-sm text-red-700">
            {apiErrorMessage(campaigns.error, "Couldn't load campaigns.")}
          </p>
        ) : list.length === 0 ? (
          <p className="p-8 text-center text-sm text-zinc-500">Nothing sent yet. Write your first offer above.</p>
        ) : (
          <table className="mt-2 w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="text-xs font-bold text-zinc-500">
                <th scope="col" className="px-4 py-3">Status</th>
                <th scope="col" className="px-4 py-3">Channel</th>
                <th scope="col" className="px-4 py-3">Title</th>
                <th scope="col" className="px-4 py-3 text-right">Delivered</th>
                <th scope="col" className="px-4 py-3">Sent</th>
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const status = STATUS[c.status];
                const editing = editingId === c.id;
                return (
                  <tr key={c.id} className={"border-t border-zinc-100 " + (editing ? "bg-[#F4F4F1]" : "")}>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-xs font-bold ${status.cls}`}
                      >
                        {c.status === "SENDING" && (
                          <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                        )}
                        {status.text}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-zinc-700">
                        {c.channel === "PUSH" ? (
                          <Bell className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        {c.channel === "PUSH" ? "Push" : "Email"}
                      </span>
                    </td>
                    <td className="max-w-[18rem] px-4 py-3">
                      <span className="block truncate font-bold" title={c.title}>
                        {c.title}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {c.status === "DRAFT" ? (
                        <span className="text-zinc-400">—</span>
                      ) : (
                        <>
                          {c.delivered.toLocaleString("en-GB")}
                          <span className="text-zinc-500"> / {c.targeted.toLocaleString("en-GB")}</span>
                        </>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-zinc-700">
                      {c.sentAt ? WHEN.format(new Date(c.sentAt)) : <span className="text-zinc-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {c.status === "DRAFT" && (
                        <span className="flex justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => onEdit(c)}
                            aria-label={`Edit draft ${c.title}`}
                            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-zinc-300 bg-white px-3 text-[13px] font-semibold hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0B0B0B]"
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => onDelete(c)}
                            disabled={deleting === c.id}
                            aria-label={`Delete draft ${c.title}`}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 disabled:opacity-50"
                          >
                            {deleting === c.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : (
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            )}
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function Field({
  label,
  id,
  count,
  children,
}: {
  label: string;
  id: string;
  count?: { used: number; max: number };
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-bold">
          {label}
        </label>
        {count && (
          <span
            id={`${id}-count`}
            className={"text-xs tabular-nums " + (count.used >= count.max ? "font-bold text-red-700" : "text-zinc-500")}
          >
            {count.used} / {count.max}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function PushPreview({ draft }: { draft: Draft }) {
  return (
    <div className="rounded-[28px] bg-gradient-to-b from-zinc-800 to-zinc-950 p-4 pb-10">
      <p className="mb-6 text-center text-4xl font-light tabular-nums text-white/90" aria-hidden="true">
        18:30
      </p>
      <div className="rounded-2xl bg-white/90 p-3 shadow-lg backdrop-blur">
        <div className="flex items-center gap-2">
          <EflMark size={20} />
          <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-zinc-600">Eat For Less</span>
          <span className="ml-auto text-[11px] text-zinc-500">now</span>
        </div>
        <p className="mt-1.5 break-words text-[14px] font-bold leading-snug text-[#0B0B0B]">
          {draft.title.trim() || "Your title"}
        </p>
        <p className="mt-0.5 break-words text-[13px] leading-snug text-zinc-700">
          {draft.body.trim() || "Your message shows here, as it will on the lock screen."}
        </p>
      </div>
    </div>
  );
}

function EmailPreview({ draft }: { draft: Draft }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-[#F4F4F1]">
      <div className="border-b border-zinc-200 bg-white px-4 py-2.5 text-xs text-zinc-600">
        <span className="font-semibold text-zinc-500">Subject: </span>
        <span className="break-words font-bold text-[#0B0B0B]">{draft.title.trim() || "Your subject"}</span>
      </div>
      <div className="p-3">
        <div className="overflow-hidden rounded-xl bg-white">
          <div className="flex items-center gap-2 bg-[#D4FF3F] px-4 py-3">
            <EflMark size={24} />
            <span className="text-sm font-extrabold tracking-tight text-[#0B0B0B]">eat for less</span>
          </div>
          <div className="flex flex-col gap-3 px-4 py-4">
            <p className="break-words text-base font-extrabold leading-snug text-[#0B0B0B]">
              {draft.title.trim() || "Your subject"}
            </p>
            <p className="whitespace-pre-line break-words text-[13px] leading-relaxed text-zinc-700">
              {draft.body.trim() || "Your message shows here."}
            </p>
            {draft.ctaLabel.trim() && (
              <span className="inline-flex h-10 w-fit items-center rounded-xl bg-[#0B0B0B] px-4 text-[13px] font-bold text-white">
                {draft.ctaLabel.trim()}
              </span>
            )}
          </div>
        </div>
        <p className="mt-2 text-center text-[10px] text-zinc-500">You get this because you said yes to offers. Unsubscribe.</p>
      </div>
    </div>
  );
}
