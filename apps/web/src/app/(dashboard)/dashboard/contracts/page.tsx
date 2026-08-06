"use client";

// Contracts — send an agreement, watch it get opened and signed.
//
// PLATFORM_ADMIN only. These are OUR agreements with clients, so the gate is
// enforced three times over: the sidebar hides the link, this page renders a
// refusal for anyone else, and the API rejects the call regardless. The page
// check exists because a direct URL bypasses the sidebar entirely.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Eye,
  FileSignature,
  FileText,
  Link2 as LinkIcon,
  Loader2,
  MessageCircle,
  Mail,
  Pencil,
  Plus,
  Send,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import {
  contractsClient,
  type Contract,
  type ContractStatus,
  type ContractTemplate,
} from "@/lib/api/contracts.client";
import { locationsClient } from "@/lib/api/locations.client";
import { useAuthStore } from "@/stores/auth.store";

const STATUS_STYLES: Record<ContractStatus, { label: string; cls: string; Icon: any }> = {
  DRAFT: { label: "Draft", cls: "bg-zinc-100 text-zinc-600", Icon: FileText },
  SENT: { label: "Sent", cls: "bg-blue-50 text-blue-700", Icon: Send },
  OPENED: { label: "Opened", cls: "bg-amber-50 text-amber-700", Icon: Eye },
  SIGNED: { label: "Signed", cls: "bg-emerald-50 text-emerald-700", Icon: CheckCircle2 },
  VOIDED: { label: "Voided", cls: "bg-red-50 text-red-600", Icon: XCircle },
};

const FILTERS: Array<{ key: string; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "DRAFT", label: "Drafts" },
  { key: "SENT", label: "Sent" },
  { key: "OPENED", label: "Opened" },
  { key: "SIGNED", label: "Signed" },
  { key: "VOIDED", label: "Voided" },
];

export default function ContractsPage() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [tab, setTab] = useState<"contracts" | "templates">("contracts");
  const [filter, setFilter] = useState("ALL");
  const [composeOpen, setComposeOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [detail, setDetail] = useState<Contract | null>(null);
  const [share, setShare] = useState<Contract | null>(null);
  const [editing, setEditing] = useState<Contract | null>(null);

  const isAdmin = user?.role === "PLATFORM_ADMIN";

  const contractsQuery = useQuery({
    queryKey: ["contracts", filter],
    queryFn: () => contractsClient.list(filter),
    enabled: isAdmin,
  });
  const templatesQuery = useQuery({
    queryKey: ["contract-templates"],
    queryFn: () => contractsClient.listTemplates(),
    enabled: isAdmin,
  });

  const send = useMutation({
    mutationFn: ({ id, emailIt }: { id: string; emailIt: boolean }) =>
      contractsClient.send(id, { emailIt }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contracts"] }),
  });
  const voidIt = useMutation({
    mutationFn: (id: string) => contractsClient.void(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contracts"] }),
  });
  const removeIt = useMutation({
    mutationFn: (id: string) => contractsClient.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contracts"] }),
  });


  if (!isAdmin) {
    return (
      <div className="p-6">
        <div className="mx-auto max-w-md rounded-xl border border-zinc-200 bg-white p-8 text-center">
          <FileSignature className="mx-auto h-8 w-8 text-zinc-300" />
          <h1 className="mt-3 text-base font-semibold text-zinc-900">
            Contracts is admin-only
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Your account doesn&apos;t have access to this section.
          </p>
        </div>
      </div>
    );
  }

  const contracts = contractsQuery.data ?? [];
  const counts = useMemo(() => {
    const all = contractsQuery.data ?? [];
    return {
      awaiting: all.filter((c) => c.status === "SENT" || c.status === "OPENED")
        .length,
      signed: all.filter((c) => c.status === "SIGNED").length,
    };
  }, [contractsQuery.data]);

  return (
    <div className="p-4 sm:p-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-zinc-900">Contracts</h1>
          <p className="text-sm text-zinc-500">
            Send agreements for e-signature and track what&apos;s been signed.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setManageOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-800 hover:border-zinc-300"
          >
            <FileText className="h-4 w-4" />
            Templates
            {(templatesQuery.data?.length ?? 0) > 0 && (
              <span className="rounded-full bg-zinc-100 px-1.5 py-0 text-[10px] tabular-nums text-zinc-600">
                {templatesQuery.data!.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setTemplateOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-800 hover:border-zinc-300"
          >
            <Plus className="h-4 w-4" />
            New template
          </button>
          <button
            onClick={() => setComposeOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-600"
          >
            <Send className="h-4 w-4" />
            New contract
          </button>
        </div>
      </header>

      {tab === "contracts" && contracts.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:max-w-sm">
          <Stat label="Awaiting signature" value={counts.awaiting} />
          <Stat label="Signed" value={counts.signed} />
        </div>
      )}

      <div className="mb-4 flex gap-1 border-b border-zinc-200">
        {(["contracts", "templates"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold capitalize transition ${
              tab === t
                ? "border-orange-500 text-zinc-900"
                : "border-transparent text-zinc-500 hover:text-zinc-800"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "contracts" ? (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${
                  filter === f.key
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {contractsQuery.isLoading ? (
            <Loading />
          ) : contracts.length === 0 ? (
            <Empty
              title="No contracts yet"
              body="Create a template, then send your first agreement."
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
              {contracts.map((c) => {
                const s = STATUS_STYLES[c.status];
                return (
                  <div
                    key={c.id}
                    className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-4 py-3 last:border-0"
                  >
                    <div className="min-w-0 flex-1">
                      <button
                        onClick={() => setDetail(c)}
                        className="text-left text-sm font-semibold text-zinc-900 hover:underline"
                      >
                        {c.title}
                      </button>
                      <p className="truncate text-xs text-zinc-500">
                        {c.recipientName} · {c.recipientEmail}
                        {c.locationName ? ` · ${c.locationName}` : ""}
                        {c.subscriptionAmountPence
                          ? ` · £${(c.subscriptionAmountPence / 100).toFixed(2)}/mo`
                          : ""}
                      </p>
                    </div>

                    <span
                      className={`inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}
                    >
                      <s.Icon className="h-3 w-3" />
                      {s.label}
                    </span>

                    <div className="flex flex-shrink-0 items-center gap-1">
                      <IconBtn
                        title="Delete this contract"
                        onClick={() => {
                          const extra =
                            c.status === "SIGNED"
                              ? "\n\nThis one is SIGNED. It disappears from your list, but the signed record and its audit trail are kept."
                              : "\n\nThe signing link stops working immediately.";
                          if (confirm(`Delete "${c.title}"?${extra}`)) {
                            removeIt.mutate(c.id);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </IconBtn>
                      {c.status !== "VOIDED" && (
                        <IconBtn
                          title={
                            c.status === "DRAFT"
                              ? "Generate a signing link to share"
                              : "Share the signing link"
                          }
                          onClick={() => setShare(c)}
                        >
                          <LinkIcon className="h-4 w-4" />
                        </IconBtn>
                      )}
                      {c.status !== "SIGNED" && c.status !== "VOIDED" && (
                        <>
                          <IconBtn
                            title="Amend this contract"
                            onClick={() => setEditing(c)}
                          >
                            <Pencil className="h-4 w-4" />
                          </IconBtn>
                          <IconBtn
                            title={
                              c.status === "DRAFT"
                                ? "Send by email"
                                : "Send a reminder by email"
                            }
                            onClick={() =>
                              send.mutate({ id: c.id, emailIt: true })
                            }
                          >
                            <Mail className="h-4 w-4" />
                          </IconBtn>
                          <IconBtn
                            title="Withdraw this contract"
                            onClick={() => {
                              if (
                                confirm(
                                  `Withdraw "${c.title}"? The link stops working immediately.`,
                                )
                              )
                                voidIt.mutate(c.id);
                            }}
                          >
                            <XCircle className="h-4 w-4" />
                          </IconBtn>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <TemplatesTab
          templates={templatesQuery.data ?? []}
          loading={templatesQuery.isLoading}
          onDeleted={() =>
            qc.invalidateQueries({ queryKey: ["contract-templates"] })
          }
        />
      )}

      {composeOpen && (
        <ComposeModal
          templates={templatesQuery.data ?? []}
          onClose={() => setComposeOpen(false)}
          onCreated={(contract, shareLink) => {
            setComposeOpen(false);
            qc.invalidateQueries({ queryKey: ["contracts"] });
            // Straight into the share sheet, so "give me a link" actually
            // ends with a link in your clipboard rather than a row you then
            // have to go and find.
            if (shareLink) setShare(contract);
          }}
        />
      )}
      {templateOpen && (
        <TemplateModal
          onClose={() => setTemplateOpen(false)}
          onCreated={() => {
            setTemplateOpen(false);
            qc.invalidateQueries({ queryKey: ["contract-templates"] });
          }}
        />
      )}
      {manageOpen && (
        <ManageTemplatesModal
          templates={templatesQuery.data ?? []}
          loading={templatesQuery.isLoading}
          onClose={() => setManageOpen(false)}
          onChanged={() =>
            qc.invalidateQueries({ queryKey: ["contract-templates"] })
          }
        />
      )}

      {editing && (
        <EditModal
          contract={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["contracts"] });
          }}
        />
      )}

      {share && (
        <ShareModal
          contract={share}
          onClose={() => setShare(null)}
          onIssued={() => qc.invalidateQueries({ queryKey: ["contracts"] })}
        />
      )}
      {detail && (
        <DetailDrawer
          contract={detail}
          onClose={() => setDetail(null)}
          onShare={(c) => {
            setDetail(null);
            setShare(c);
          }}
        />
      )}
    </div>
  );
}

// ── Templates tab ──────────────────────────────────────────────────────────

function TemplatesTab({
  templates,
  loading,
  onDeleted,
}: {
  templates: ContractTemplate[];
  loading: boolean;
  onDeleted: () => void;
}) {
  const del = useMutation({
    mutationFn: (id: string) => contractsClient.deleteTemplate(id),
    onSuccess: onDeleted,
  });

  if (loading) return <Loading />;

  return (
    <div className="space-y-6">
      <StarterTemplates onInstalled={onDeleted} />

      {templates.length === 0 ? (
        <Empty
          title="No templates of your own yet"
          body="Add one of the ready-made agreements above, or write your own — a template is the reusable body of an agreement you send to any number of clients."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {templates.map((t) => (
        <div
          key={t.id}
          className="rounded-xl border border-zinc-200 bg-white p-4"
        >
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-900">{t.name}</h3>
            <button
              title="Delete template"
              onClick={() => {
                if (confirm(`Delete template "${t.name}"?`)) del.mutate(t.id);
              }}
              className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-red-600"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          {t.description && (
            <p className="mt-1 line-clamp-2 text-xs text-zinc-500">
              {t.description}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Tag>{t.fileUrl ? "Uploaded file" : "Written"}</Tag>
            {t.subscriptionAmountPence ? (
              <Tag>£{(t.subscriptionAmountPence / 100).toFixed(2)}/mo</Tag>
            ) : null}
          </div>
          </div>
        ))}
        </div>
      )}
    </div>
  );
}

/**
 * The agreements we ship, ready to add in one click.
 *
 * Installing COPIES the wording into a template the operator owns, so editing
 * theirs is safe and a later change to ours never rewrites an agreement that
 * has already been signed.
 */
function StarterTemplates({ onInstalled }: { onInstalled: () => void }) {
  const qc = useQueryClient();
  const starters = useQuery({
    queryKey: ["contract-starters"],
    queryFn: () => contractsClient.listStarters(),
  });

  const install = useMutation({
    mutationFn: (key: string) => contractsClient.installStarter(key),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contract-starters"] });
      onInstalled();
    },
  });

  const rows = starters.data ?? [];
  if (!rows.length) return null;

  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-zinc-900">
        Ready-made agreements
      </h2>
      <p className="mb-3 text-xs text-zinc-500">
        Written for Order Hub Solutions Ltd. Adding one copies it into your own
        templates, where you can edit the wording freely.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((s) => (
          <div
            key={s.key}
            className="flex flex-col rounded-xl border border-dashed border-zinc-300 bg-zinc-50/60 p-4"
          >
            <h3 className="text-sm font-semibold text-zinc-900">{s.name}</h3>
            <p className="mt-1 flex-1 text-xs leading-snug text-zinc-500">
              {s.description}
            </p>
            <button
              disabled={s.installed || install.isPending}
              onClick={() => install.mutate(s.key)}
              className="mt-3 inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-800 hover:border-zinc-400 disabled:opacity-50"
            >
              {s.installed ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                  Added
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5" />
                  Add to my templates
                </>
              )}
            </button>
          </div>
        ))}
      </div>
      <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-900">
        These are a solid starting point, not legal advice. Have a solicitor
        review the wording before you send it to a client — particularly the
        liability, commission and termination clauses.
      </p>
    </section>
  );
}

// ── Manage templates ───────────────────────────────────────────────────────

/**
 * The templates you already have, and a way to delete them.
 *
 * Reachable from a button beside "New template" rather than only from the
 * Templates tab: an old three-clause draft sitting in the list is something
 * you go looking for when you notice it, not something you find by changing
 * tabs first.
 */
function ManageTemplatesModal({
  templates,
  loading,
  onClose,
  onChanged,
}: {
  templates: ContractTemplate[];
  loading: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const del = useMutation({
    mutationFn: (id: string) => contractsClient.deleteTemplate(id),
    onSuccess: onChanged,
  });

  return (
    <Modal title="Your templates" onClose={onClose}>
      {loading ? (
        <p className="py-8 text-center text-sm text-zinc-400">Loading…</p>
      ) : templates.length === 0 ? (
        <p className="py-8 text-center text-sm text-zinc-500">
          No templates yet. &ldquo;New template&rdquo; starts you off with the
          full agreement.
        </p>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => (
            <div
              key={t.id}
              className="flex items-start gap-3 rounded-lg border border-zinc-200 p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-zinc-900">
                  {t.name}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {/* Which kind decides what it can do — a written template
                      personalises per client, an uploaded PDF cannot. */}
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      t.fileUrl
                        ? "bg-amber-50 text-amber-700"
                        : "bg-emerald-50 text-emerald-700"
                    }`}
                  >
                    {t.fileUrl ? "Uploaded PDF" : "Written — auto-fills"}
                  </span>
                  {!t.fileUrl && (
                    <span className="text-[10px] text-zinc-400">
                      {(t.bodyHtml ?? "").length.toLocaleString()} characters
                    </span>
                  )}
                </div>
                {t.description && (
                  <p className="mt-1 line-clamp-2 text-[11px] text-zinc-500">
                    {t.description}
                  </p>
                )}
              </div>
              <button
                onClick={() => {
                  if (
                    confirm(
                      `Delete template "${t.name}"?\n\nContracts already sent from it are unaffected — their wording was copied at the time.`,
                    )
                  ) {
                    del.mutate(t.id);
                  }
                }}
                className="flex-shrink-0 rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-600"
                title="Delete template"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ── Amend ──────────────────────────────────────────────────────────────────

/**
 * Correct a contract that has already gone out.
 *
 * Only reachable while unsigned — the API refuses a signed one, and the row
 * action is hidden for them. The signing link is unchanged, so a copy already
 * sitting in someone's inbox keeps working.
 */
function EditModal({
  contract,
  onClose,
  onSaved,
}: {
  contract: Contract;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(contract.title);
  const [recipientName, setRecipientName] = useState(contract.recipientName);
  const [recipientEmail, setRecipientEmail] = useState(contract.recipientEmail);
  const [recipientCompany, setRecipientCompany] = useState(
    contract.recipientCompany ?? "",
  );
  const [amount, setAmount] = useState(
    contract.subscriptionAmountPence != null
      ? (contract.subscriptionAmountPence / 100).toFixed(2)
      : "",
  );
  const [commission, setCommission] = useState(
    contract.commissionPercent != null ? String(contract.commissionPercent) : "",
  );
  const [serviceCharge, setServiceCharge] = useState(
    contract.customerServiceChargePence != null
      ? (contract.customerServiceChargePence / 100).toFixed(2)
      : "",
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      contractsClient.update(contract.id, {
        title: title.trim(),
        recipientName: recipientName.trim(),
        recipientEmail: recipientEmail.trim(),
        recipientCompany: recipientCompany.trim() || null,
        // null rather than undefined: an emptied box must REMOVE the term,
        // and undefined would mean "leave it as it was".
        subscriptionAmountPence: amount.trim()
          ? Math.round(parseFloat(amount) * 100)
          : null,
        commissionPercent: commission.trim() ? parseFloat(commission) : null,
        customerServiceChargePence: serviceCharge.trim()
          ? Math.round(parseFloat(serviceCharge) * 100)
          : null,
      }),
    onSuccess: onSaved,
    onError: (e: any) =>
      setError(e?.response?.data?.message ?? "Couldn't save those changes"),
  });

  return (
    <Modal title="Amend contract" onClose={onClose}>
      <div className="space-y-3">
        {contract.firstOpenedAt && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-900">
            {contract.recipientName} has already opened this. Saving changes
            marks it unread again and records the amendment on the audit trail
            — they may have read different terms to the ones they sign.
          </p>
        )}

        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Client name">
            <input
              value={recipientName}
              onChange={(e) => setRecipientName(e.target.value)}
              className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
            />
          </Field>
          <Field label="Client email">
            <input
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
            />
          </Field>
        </div>

        <Field label="Company">
          <input
            value={recipientCompany}
            onChange={(e) => setRecipientCompany(e.target.value)}
            className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Subscription (£/mo)">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
            />
          </Field>
          <Field label="Commission (%)">
            <input
              value={commission}
              onChange={(e) => setCommission(e.target.value)}
              inputMode="decimal"
              className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
            />
          </Field>
          <Field label="Service charge (£)">
            <input
              value={serviceCharge}
              onChange={(e) => setServiceCharge(e.target.value)}
              inputMode="decimal"
              className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
            />
          </Field>
        </div>
        <p className="text-[11px] text-zinc-500">
          Emptying a fee box removes that clause from the agreement. The
          wording is re-rendered from the original template, so clauses edited
          in the template since aren&apos;t pulled in.
        </p>

        {error && <p className="text-[12px] text-red-600">{error}</p>}

        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
        >
          {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Save changes
        </button>
      </div>
    </Modal>
  );
}

// ── Share by link ──────────────────────────────────────────────────────────

/**
 * The link half of "send by email OR send a link".
 *
 * Opening this on a DRAFT ISSUES the contract first. Copying the URL straight
 * off the row looked like it worked and didn't: a draft can't be signed, so
 * the client would open the page, type their name, and be told the contract
 * isn't ready. Issuing here moves it to SENT so the link works wherever it
 * ends up — WhatsApp, SMS, read down the phone.
 */
function ShareModal({
  contract,
  onClose,
  onIssued,
}: {
  contract: Contract;
  onClose: () => void;
  onIssued: () => void;
}) {
  const [url, setUrl] = useState<string | null>(
    contract.status === "DRAFT" ? null : contract.signingUrl,
  );
  const [issuing, setIssuing] = useState(contract.status === "DRAFT");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (contract.status !== "DRAFT") return;
    let cancelled = false;
    contractsClient
      .generateLink(contract.id)
      .then((link) => {
        if (cancelled) return;
        setUrl(link);
        onIssued();
      })
      .catch((e: any) =>
        setError(e?.response?.data?.message ?? "Couldn't generate the link"),
      )
      .finally(() => !cancelled && setIssuing(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract.id]);

  const copy = () => {
    if (!url) return;
    navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const message = `Hi ${contract.recipientName}, please review and sign "${contract.title}": ${url ?? ""}`;

  return (
    <Modal title="Share signing link" onClose={onClose}>
      {issuing ? (
        <div className="flex items-center gap-2 py-8 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Generating the link…
        </div>
      ) : error ? (
        <p className="py-6 text-sm text-red-600">{error}</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-zinc-600">
            Anyone with this link can open and sign the agreement — send it only
            to {contract.recipientName}.
          </p>

          <div className="flex items-center gap-2">
            <input
              readOnly
              value={url ?? ""}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-2 text-xs"
            />
            <button
              onClick={copy}
              className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-2 text-xs font-semibold text-white"
            >
              {copied ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-semibold text-zinc-700">
              Or share it directly
            </p>
            <div className="flex flex-wrap gap-2">
              <a
                href={`https://wa.me/?text=${encodeURIComponent(message)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-sm font-semibold text-zinc-800 hover:border-zinc-300"
              >
                <MessageCircle className="h-4 w-4" />
                WhatsApp
              </a>
              <a
                href={`mailto:${encodeURIComponent(contract.recipientEmail)}?subject=${encodeURIComponent(`Please sign: ${contract.title}`)}&body=${encodeURIComponent(message)}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-sm font-semibold text-zinc-800 hover:border-zinc-300"
              >
                <Mail className="h-4 w-4" />
                Your mail app
              </a>
            </div>
            <p className="mt-2 text-[11px] text-zinc-500">
              These open your own WhatsApp or mail client. To send it from Order
              Hub instead, use the envelope button on the contract row.
            </p>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Compose ────────────────────────────────────────────────────────────────

function ComposeModal({
  templates,
  onClose,
  onCreated,
}: {
  templates: ContractTemplate[];
  onClose: () => void;
  onCreated: (contract: Contract, shareLink: boolean) => void;
}) {
  const [templateId, setTemplateId] = useState("");
  const [title, setTitle] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientCompany, setRecipientCompany] = useState("");
  const [companyNumber, setCompanyNumber] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [locationCount, setLocationCount] = useState("");
  const [locationId, setLocationId] = useState("");
  const [amount, setAmount] = useState("");
  // Both optional. Left blank, the matching clause is removed from the
  // agreement entirely rather than printed as zero.
  const [commission, setCommission] = useState("");
  const [serviceCharge, setServiceCharge] = useState("");
  const [sendNow, setSendNow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [senderOpen, setSenderOpen] = useState(false);
  const [sender, setSender] = useState({
    name: "",
    companyNumber: "",
    address: "",
  });

  const locations = useQuery({
    queryKey: ["locations", "for-contracts"],
    queryFn: () => locationsClient.list(),
  });

  // Prefilled so the operator edits real values rather than guessing what the
  // certificate will say.
  const issuerDefaults = useQuery({
    queryKey: ["contract-issuer-defaults"],
    queryFn: () => contractsClient.issuerDefaults(),
  });
  useEffect(() => {
    const d = issuerDefaults.data;
    if (!d || sender.name) return;
    setSender({
      name: d.name ?? "",
      companyNumber: d.companyNumber ?? "",
      address: d.address ?? "",
    });
  }, [issuerDefaults.data, sender.name]);

  const chosen = templates.find((t) => t.id === templateId);
  // An uploaded file is a fixed document: fillPlaceholders only runs on
  // written HTML, so nothing in a PDF can be personalised per client.
  const isFileTemplate = !!chosen?.fileUrl;

  const senderChanged =
    !!issuerDefaults.data &&
    (sender.name !== (issuerDefaults.data.name ?? "") ||
      sender.companyNumber !== (issuerDefaults.data.companyNumber ?? "") ||
      sender.address !== (issuerDefaults.data.address ?? ""));

  const create = useMutation({
    mutationFn: async () => {
      const pence = amount.trim()
        ? Math.round(parseFloat(amount) * 100)
        : undefined;
      const contract = await contractsClient.create({
        templateId: templateId || undefined,
        title: title.trim() || undefined,
        recipientName: recipientName.trim(),
        recipientEmail: recipientEmail.trim(),
        recipientCompany: recipientCompany.trim() || undefined,
        recipientCompanyNumber: companyNumber.trim() || undefined,
        recipientAddress: address.trim() || undefined,
        recipientPhone: phone.trim() || undefined,
        locationCount: locationCount.trim()
          ? parseInt(locationCount, 10)
          : undefined,
        locationId: locationId || undefined,
        subscriptionAmountPence: pence,
        commissionPercent: commission.trim()
          ? parseFloat(commission)
          : undefined,
        customerServiceChargePence: serviceCharge.trim()
          ? Math.round(parseFloat(serviceCharge) * 100)
          : undefined,
        // Sent only when edited, so a later change to the registered address
        // updates every contract that never needed an override.
        issuer: senderChanged ? sender : null,
      });
      if (sendNow) await contractsClient.send(contract.id, { emailIt: true });
      // Link mode deliberately leaves it a DRAFT: ShareModal issues it as it
      // hands the link over, so there is exactly one place that does that and
      // no way to end up with an issued contract nobody has the link to.
      return contract;
    },
    onSuccess: (contract) => onCreated(contract, !sendNow),
    onError: (e: any) =>
      setError(e?.response?.data?.message ?? "Couldn't create that contract"),
  });

  const canSubmit =
    !!templateId && !!recipientName.trim() && !!recipientEmail.trim();

  return (
    <Modal title="New contract" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Template">
          <select
            value={templateId}
            onChange={(e) => {
              setTemplateId(e.target.value);
              const t = templates.find((x) => x.id === e.target.value);
              if (t?.subscriptionAmountPence)
                setAmount((t.subscriptionAmountPence / 100).toFixed(2));
            }}
            className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
          >
            <option value="">Choose a template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {templates.length === 0 && (
            <p className="mt-1 text-[11px] text-amber-600">
              You need a template first — close this and use “New template”.
            </p>
          )}
        </Field>

        <Field label="Title (optional)">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={chosen?.name ?? "Uses the template name"}
            className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Client name">
            <input
              value={recipientName}
              onChange={(e) => setRecipientName(e.target.value)}
              className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
            />
          </Field>
          <Field label="Client email">
            <input
              type="email"
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
            />
          </Field>
        </div>

        <Field label="Company (optional)">
          <input
            value={recipientCompany}
            onChange={(e) => setRecipientCompany(e.target.value)}
            className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
          />
        </Field>

        {/* Parties-clause detail. All optional — a sole trader has no company
            number, and the agreement drops the line rather than printing a
            label with nothing after it. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Company number (optional)">
            <input
              value={companyNumber}
              onChange={(e) => setCompanyNumber(e.target.value)}
              placeholder="12345678"
              className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
            />
          </Field>
          <Field label="Client phone (optional)">
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="0191 123 4567"
              className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
            />
          </Field>
        </div>

        <Field label="Client address (optional)">
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="7 Front Street, Pelton, DH2 1DD"
            className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
          />
        </Field>

        <Field label="Number of locations (optional)">
          <input
            value={locationCount}
            onChange={(e) => setLocationCount(e.target.value)}
            placeholder="1"
            inputMode="numeric"
            className="w-32 rounded-md border border-zinc-200 px-2 py-2 text-sm"
          />
          <p className="mt-1 text-[11px] text-zinc-500">
            Reads as &quot;1 location&quot; or &quot;3 locations&quot; in the
            agreement. Blank leaves it out.
          </p>
        </Field>

        <Field label="Location this covers (optional)">
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
          >
            <option value="">No specific location</option>
            {(locations.data ?? []).map((l: any) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>

        {isFileTemplate && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-900">
            <strong>This template is an uploaded file.</strong> The client&apos;s
            name, company, location and price are printed into the PDF as it
            stands and cannot be filled in per client — everyone receives the
            same document. Use a written template if you need those to change.
          </div>
        )}

        <Field label="Monthly subscription (optional)">
          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-500">£</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="49.00"
              inputMode="decimal"
              className="w-32 rounded-md border border-zinc-200 px-2 py-2 text-sm"
            />
            <span className="text-xs text-zinc-500">per month</span>
          </div>
          <p className="mt-1 text-[11px] text-zinc-500">
            Set this and the signed contract shows a Subscribe button. It needs
            a location — that&apos;s what gets subscribed.
          </p>
          {amount.trim() && !locationId && (
            <p className="mt-1 text-[11px] text-amber-600">
              Pick a location, or the Subscribe button won&apos;t appear.
            </p>
          )}
        </Field>

        <Field label="Commission per order (optional)">
          <div className="flex items-center gap-2">
            <input
              value={commission}
              onChange={(e) => setCommission(e.target.value)}
              placeholder="2.5"
              inputMode="decimal"
              className="w-32 rounded-md border border-zinc-200 px-2 py-2 text-sm"
            />
            <span className="text-sm text-zinc-500">% of each order</span>
          </div>
          <p className="mt-1 text-[11px] text-zinc-500">
            Leave blank and the commission clause is removed from the agreement
            — not printed as 0%.
          </p>
        </Field>

        <Field label="Customer service charge per order (optional)">
          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-500">£</span>
            <input
              value={serviceCharge}
              onChange={(e) => setServiceCharge(e.target.value)}
              placeholder="0.50"
              inputMode="decimal"
              className="w-32 rounded-md border border-zinc-200 px-2 py-2 text-sm"
            />
            <span className="text-xs text-zinc-500">per order</span>
          </div>
          <p className="mt-1 text-[11px] text-zinc-500">
            Paid by the customer at checkout, not by the client. Blank removes
            the clause.
          </p>
        </Field>

        <div>
          <button
            type="button"
            onClick={() => setSenderOpen((o) => !o)}
            className="text-xs font-semibold text-zinc-600 underline"
          >
            {senderOpen ? "Hide" : "Edit"} sender details on the certificate
          </button>
          {senderOpen && (
            <div className="mt-2 space-y-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
              <p className="text-[11px] leading-snug text-zinc-500">
                Shown as &ldquo;Issued by&rdquo; on the signature certificate,
                alongside the signer&apos;s details.
              </p>
              <input
                value={sender.name}
                onChange={(e) =>
                  setSender((v) => ({ ...v, name: e.target.value }))
                }
                placeholder="Company name"
                className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
              />
              <input
                value={sender.companyNumber}
                onChange={(e) =>
                  setSender((v) => ({ ...v, companyNumber: e.target.value }))
                }
                placeholder="Company number"
                className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
              />
              <input
                value={sender.address}
                onChange={(e) =>
                  setSender((v) => ({ ...v, address: e.target.value }))
                }
                placeholder="Registered address"
                className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
              />
            </div>
          )}
        </div>

        <Field label="How do you want to send it?">
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                {
                  key: "email",
                  Icon: Mail,
                  title: "Email it now",
                  body: `We email ${recipientEmail.trim() || "the client"} the signing link.`,
                },
                {
                  key: "link",
                  Icon: LinkIcon,
                  title: "Give me a link",
                  body: "Copy it and send however you like — WhatsApp, SMS, in person.",
                },
              ] as const
            ).map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setSendNow(opt.key === "email")}
                className={`rounded-lg border p-3 text-left transition ${
                  (opt.key === "email") === sendNow
                    ? "border-orange-500 bg-orange-50"
                    : "border-zinc-200 hover:border-zinc-300"
                }`}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
                  <opt.Icon className="h-4 w-4" />
                  {opt.title}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">
                  {opt.body}
                </span>
              </button>
            ))}
          </div>
        </Field>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-semibold text-zinc-700"
          >
            Cancel
          </button>
          <button
            disabled={!canSubmit || create.isPending}
            onClick={() => {
              setError(null);
              create.mutate();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {sendNow ? "Create & email" : "Create & get link"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Template builder ───────────────────────────────────────────────────────

// The body box starts from the SHIPPED agreement, fetched from the API.
//
// It used to start from a three-clause sample hardcoded here. That sample
// looked enough like a contract to be saved and sent as one — which is exactly
// what happened — while the full agreement sat unused behind a button on the
// Templates tab. There is now one piece of wording and it is the real one.

function TemplateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [kind, setKind] = useState<"write" | "upload">("write");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [starterKey, setStarterKey] = useState("saas-agreement");
  const [amount, setAmount] = useState("");
  const [fileUrl, setFileUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const starters = useQuery({
    queryKey: ["contract-starters"],
    queryFn: () => contractsClient.listStarters(),
  });

  // Prefill once the wording arrives, and again whenever the operator picks a
  // different starting point — but never over their own edits.
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current) return;
    const pick = (starters.data ?? []).find((x) => x.key === starterKey);
    if (pick?.bodyHtml) {
      setBodyHtml(pick.bodyHtml);
      if (!name.trim()) setName(pick.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starters.data, starterKey]);

  const create = useMutation({
    mutationFn: () =>
      contractsClient.createTemplate({
        name: name.trim(),
        description: description.trim() || undefined,
        bodyHtml: kind === "write" ? bodyHtml : undefined,
        fileUrl: kind === "upload" ? fileUrl : undefined,
        fileName: kind === "upload" ? fileName : undefined,
        fileType: kind === "upload" ? "application/pdf" : undefined,
        subscriptionAmountPence: amount.trim()
          ? Math.round(parseFloat(amount) * 100)
          : undefined,
      }),
    onSuccess: onCreated,
    onError: (e: any) =>
      setError(e?.response?.data?.message ?? "Couldn't save that template"),
  });

  const onFile = async (file: File) => {
    if (file.type !== "application/pdf") {
      setError("Please upload a PDF — other formats can't be displayed for signing.");
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const dataUrl: string = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = rej;
        fr.readAsDataURL(file);
      });
      const { apiClient } = await import("@/lib/api/client");
      const { data } = await apiClient.post<{ publicUrl: string }>(
        "/v1/uploads/contract-file",
        { dataUrl, fileName: file.name },
      );
      setFileUrl(data.publicUrl);
      setFileName(file.name);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const canSubmit =
    !!name.trim() && (kind === "write" ? !!bodyHtml.trim() : !!fileUrl);

  return (
    <Modal title="New template" onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex gap-1 rounded-lg bg-zinc-100 p-1">
          {(["write", "upload"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-semibold capitalize ${
                kind === k ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-600"
              }`}
            >
              {k === "write" ? "Write it" : "Upload a PDF"}
            </button>
          ))}
        </div>

        <Field label="Template name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Standard service agreement"
            className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
          />
        </Field>

        <Field label="Description (optional)">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-md border border-zinc-200 px-2 py-2 text-sm"
          />
        </Field>

        {kind === "write" && (starters.data?.length ?? 0) > 0 && (
          <Field label="Start from">
            <div className="flex flex-wrap gap-2">
              {(starters.data ?? []).map((st) => (
                <button
                  key={st.key}
                  type="button"
                  onClick={() => {
                    // Explicit switch: honour it even if they have typed, but
                    // say so rather than silently discarding their work.
                    if (
                      touched.current &&
                      !confirm("Replace what you've written with this agreement?")
                    ) {
                      return;
                    }
                    touched.current = false;
                    setStarterKey(st.key);
                    setBodyHtml(st.bodyHtml);
                    setName((n) => (n.trim() ? n : st.name));
                  }}
                  className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold transition ${
                    starterKey === st.key
                      ? "border-orange-500 bg-orange-50 text-orange-900"
                      : "border-zinc-200 text-zinc-700 hover:border-zinc-300"
                  }`}
                >
                  {st.name}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">
              These are the full ready-made agreements. Edit freely — your copy
              is yours, and a later change to ours never rewrites it.
            </p>
          </Field>
        )}

        {kind === "write" ? (
          <Field label="Body">
            <textarea
              value={bodyHtml}
              onChange={(e) => {
                touched.current = true;
                setBodyHtml(e.target.value);
              }}
              rows={14}
              className="w-full rounded-md border border-zinc-200 px-2 py-2 font-mono text-xs leading-relaxed"
            />
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              HTML. Placeholders filled per contract:{" "}
              {[
                "recipientName",
                "recipientEmail",
                "recipientCompany",
                "recipientCompanyNumber",
                "recipientAddress",
                "recipientPhone",
                "location",
                "locationWord",
                "amount",
                "commission",
                "serviceCharge",
                "date",
              ].map((k, i) => (
                <span key={k}>
                  {i > 0 && ", "}
                  <code>{`{{${k}}}`}</code>
                </span>
              ))}
              .
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              Wrap an optional clause in <code>{"{{#commission}}"}</code> …{" "}
              <code>{"{{/commission}}"}</code> and the whole block disappears
              when that value is left blank — so an unset fee removes the
              clause rather than printing an empty gap.
            </p>
          </Field>
        ) : (
          <Field label="PDF">
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
              }}
              className="w-full text-sm"
            />
            {uploading && (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
                <Loader2 className="h-3 w-3 animate-spin" /> Uploading…
              </p>
            )}
            {fileUrl && (
              <p className="mt-1 text-xs text-emerald-700">
                Uploaded {fileName}
              </p>
            )}
          </Field>
        )}

        <Field label="Default monthly subscription (optional)">
          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-500">£</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="49.00"
              inputMode="decimal"
              className="w-32 rounded-md border border-zinc-200 px-2 py-2 text-sm"
            />
          </div>
        </Field>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-semibold text-zinc-700"
          >
            Cancel
          </button>
          <button
            disabled={!canSubmit || create.isPending}
            onClick={() => {
              setError(null);
              create.mutate();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Save template
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Detail / audit trail ───────────────────────────────────────────────────

function DetailDrawer({
  contract,
  onClose,
  onShare,
}: {
  contract: Contract;
  onClose: () => void;
  onShare: (c: Contract) => void;
}) {
  const full = useQuery({
    queryKey: ["contract", contract.id],
    queryFn: () => contractsClient.get(contract.id),
  });
  const c = full.data ?? contract;
  const events = (full.data as any)?.events ?? [];

  return (
    <Modal title={c.title} onClose={onClose} wide>
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Row label="Client" value={`${c.recipientName} (${c.recipientEmail})`} />
          <Row label="Status" value={STATUS_STYLES[c.status].label} />
          <Row label="Location" value={c.locationName ?? "—"} />
          <Row
            label="Subscription"
            value={
              c.subscriptionAmountPence
                ? `£${(c.subscriptionAmountPence / 100).toFixed(2)}/mo`
                : "—"
            }
          />
          <Row label="Sent" value={fmt(c.sentAt)} />
          <Row label="First opened" value={fmt(c.firstOpenedAt)} />
          <Row label="Signed" value={fmt(c.signedAt)} />
          <Row label="Signed by" value={c.signerName ?? "—"} />
          <Row label="Signer IP" value={c.signerIp ?? "—"} />
          <Row
            label="Subscribed"
            value={fmt(c.subscriptionStartedAt)}
          />
        </dl>

        {c.status === "SIGNED" && (
          <button
            onClick={() =>
              contractsClient.downloadPdf(
                c.id,
                `${c.title.replace(/[^a-zA-Z0-9 _-]/g, "").trim().replace(/\s+/g, "-") || "contract"}-signed.pdf`,
              )
            }
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-2.5 text-sm font-semibold text-white hover:bg-zinc-800"
          >
            <Download className="h-4 w-4" />
            Download signed PDF
          </button>
        )}

        {c.status !== "VOIDED" && (
          <button
            onClick={() => onShare(c)}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2.5 text-sm font-semibold text-zinc-800 hover:border-zinc-300"
          >
            <LinkIcon className="h-4 w-4" />
            {c.status === "DRAFT"
              ? "Generate signing link"
              : "Share signing link"}
          </button>
        )}

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Audit trail
          </p>
          {full.isLoading ? (
            <Loading />
          ) : events.length === 0 ? (
            <p className="text-xs text-zinc-400">Nothing recorded yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {events.map((e: any) => (
                <li
                  key={e.id}
                  className="flex flex-wrap items-baseline gap-x-2 rounded-md bg-zinc-50 px-2 py-1.5 text-xs"
                >
                  <span className="font-semibold text-zinc-800">{e.type}</span>
                  <span className="text-zinc-500">{fmt(e.createdAt)}</span>
                  {e.ip && <span className="text-zinc-400">from {e.ip}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Small shared bits ──────────────────────────────────────────────────────

function fmt(v: string | null | undefined) {
  return v ? new Date(v).toLocaleString("en-GB") : "—";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-zinc-400">
        {label}
      </dt>
      <dd className="truncate text-zinc-800">{value}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p className="text-xl font-bold text-zinc-900">{value}</p>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600">
      {children}
    </span>
  );
}

function IconBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
    >
      {children}
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-zinc-700">
        {label}
      </label>
      {children}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-zinc-400">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-200 bg-white py-12 text-center">
      <FileSignature className="mx-auto h-7 w-7 text-zinc-300" />
      <p className="mt-2 text-sm font-semibold text-zinc-800">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-xs text-zinc-500">{body}</p>
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl ${
          wide ? "sm:max-w-2xl" : "sm:max-w-lg"
        }`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
