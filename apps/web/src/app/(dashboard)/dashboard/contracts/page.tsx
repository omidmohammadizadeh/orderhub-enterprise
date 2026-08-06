"use client";

// Contracts — send an agreement, watch it get opened and signed.
//
// PLATFORM_ADMIN only. These are OUR agreements with clients, so the gate is
// enforced three times over: the sidebar hides the link, this page renders a
// refusal for anyone else, and the API rejects the call regardless. The page
// check exists because a direct URL bypasses the sidebar entirely.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clock,
  Copy,
  Eye,
  FileSignature,
  FileText,
  Loader2,
  Mail,
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
  const [detail, setDetail] = useState<Contract | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

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

  const copyLink = (c: Contract) => {
    navigator.clipboard?.writeText(c.signingUrl);
    setCopied(c.id);
    setTimeout(() => setCopied((v) => (v === c.id ? null : v)), 2000);
  };

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
                        title="Copy signing link"
                        onClick={() => copyLink(c)}
                      >
                        {copied === c.id ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </IconBtn>
                      {c.status !== "SIGNED" && c.status !== "VOIDED" && (
                        <>
                          <IconBtn
                            title={
                              c.status === "DRAFT"
                                ? "Send by email"
                                : "Send a reminder"
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
          onCreated={() => {
            setComposeOpen(false);
            qc.invalidateQueries({ queryKey: ["contracts"] });
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
      {detail && (
        <DetailDrawer contract={detail} onClose={() => setDetail(null)} />
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
  if (templates.length === 0)
    return (
      <Empty
        title="No templates yet"
        body="A template is the reusable body of an agreement — write it once, send it to any number of clients."
      />
    );

  return (
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
  onCreated: () => void;
}) {
  const [templateId, setTemplateId] = useState("");
  const [title, setTitle] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientCompany, setRecipientCompany] = useState("");
  const [locationId, setLocationId] = useState("");
  const [amount, setAmount] = useState("");
  const [sendNow, setSendNow] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const locations = useQuery({
    queryKey: ["locations", "for-contracts"],
    queryFn: () => locationsClient.list(),
  });

  const chosen = templates.find((t) => t.id === templateId);

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
        locationId: locationId || undefined,
        subscriptionAmountPence: pence,
      });
      if (sendNow) await contractsClient.send(contract.id, { emailIt: true });
      return contract;
    },
    onSuccess: onCreated,
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

        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={sendNow}
            onChange={(e) => setSendNow(e.target.checked)}
          />
          Email it to the client straight away
        </label>

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
            {sendNow ? "Create & send" : "Create draft"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Template builder ───────────────────────────────────────────────────────

const STARTER_BODY = `<h2>Service Agreement</h2>
<p>This agreement is made between OrderHub Solutions and {{recipientCompany}}
("the Client") on {{date}}.</p>

<h3>1. Services</h3>
<p>OrderHub will provide its restaurant ordering and management platform for
{{location}}.</p>

<h3>2. Fees</h3>
<p>The Client agrees to pay {{amount}} per month.</p>

<h3>3. Term</h3>
<p>This agreement runs month to month and may be cancelled by either party
with 30 days' written notice.</p>`;

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
  const [bodyHtml, setBodyHtml] = useState(STARTER_BODY);
  const [amount, setAmount] = useState("");
  const [fileUrl, setFileUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

        {kind === "write" ? (
          <Field label="Body">
            <textarea
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              rows={14}
              className="w-full rounded-md border border-zinc-200 px-2 py-2 font-mono text-xs leading-relaxed"
            />
            <p className="mt-1 text-[11px] text-zinc-500">
              HTML. Placeholders filled per contract:{" "}
              <code>{"{{recipientName}}"}</code>,{" "}
              <code>{"{{recipientCompany}}"}</code>, <code>{"{{location}}"}</code>,{" "}
              <code>{"{{amount}}"}</code>, <code>{"{{date}}"}</code>
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
}: {
  contract: Contract;
  onClose: () => void;
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

        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Signing link
          </p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={c.signingUrl}
              className="min-w-0 flex-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs"
            />
            <button
              onClick={() => navigator.clipboard?.writeText(c.signingUrl)}
              className="rounded-md border border-zinc-200 px-2 py-1.5 text-xs font-semibold"
            >
              Copy
            </button>
          </div>
        </div>

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
