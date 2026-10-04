"use client";

// Email Marketing — campaigns a restaurant sends to its own subscribed
// customers. Consent-first: only people who ticked "Email me offers" (or that
// the restaurant imported with a consent declaration) are ever mailed; every
// email carries one-click unsubscribe; bounces and spam complaints suppress the
// address for good. Billed from the wallet per 1,000 after a free allowance.

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  Loader2,
  Mail,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Upload,
  UserPlus,
  Users,
  Wallet as WalletIcon,
  X,
  Zap,
} from "lucide-react";
import { EMAIL_TEMPLATES, renderEmail, type EmailProduct } from "@orderhub/shared";
import { POWERED_BY } from "@/components/email-marketing/email-preview";
import {
  apiErrorMessage,
  emailMarketingClient,
  formatMinor,
  type EmailCampaignSummary,
  type EmailContactStatus,
  type EmailImportReport,
  type EmailMarketingContext,
} from "@/lib/api/email-marketing.client";
import { parseEmailFile, parseEmailText, type EmailRow } from "@/lib/email-marketing/parse-email-contacts";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { cn } from "@/lib/utils";
import { EmailStatusBadge } from "@/components/email-marketing/status-badge";
import { AutomationsTab } from "@/components/email-marketing/automations-tab";

type Tab = "campaigns" | "automations" | "audience";

export default function EmailMarketingPage() {
  const [tab, setTab] = useState<Tab>("campaigns");
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const { data: ctx } = useQuery({
    queryKey: ["email-mkt", "context", locationId],
    queryFn: () => emailMarketingClient.context(locationId),
  });
  const { data: stats } = useQuery({
    queryKey: ["email-mkt", "contacts", "stats", locationId],
    queryFn: () => emailMarketingClient.contacts({ locationId, limit: 1 }),
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700">
            <Mail className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-zinc-900">Email Marketing</h1>
            <p className="text-sm text-zinc-500">
              {stats
                ? `${stats.subscribed.toLocaleString()} subscribed customer${stats.subscribed === 1 ? "" : "s"}`
                : "Send beautiful offers to your own customers"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard/wallet"
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            <WalletIcon className="h-4 w-4 text-emerald-600" /> Wallet
          </Link>
        </div>
      </div>

      {ctx && <AllowanceBar ctx={ctx} />}

      <div className="mt-6 flex gap-1 border-b border-zinc-200">
        {(
          [
            ["campaigns", "Campaigns", Send],
            ["automations", "Automations", Zap],
            ["audience", "Audience", Users],
          ] as [Tab, string, any][]
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition",
              tab === key
                ? "border-indigo-600 text-indigo-700"
                : "border-transparent text-zinc-500 hover:text-zinc-800",
            )}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === "campaigns" && <CampaignsTab ctx={ctx} />}
        {tab === "automations" && <AutomationsTab />}
        {tab === "audience" && <AudienceTab />}
      </div>
    </div>
  );
}

function AllowanceBar({ ctx }: { ctx: EmailMarketingContext }) {
  const pct = ctx.freePerMonth > 0 ? Math.min(100, (ctx.usedThisMonth / ctx.freePerMonth) * 100) : 100;
  return (
    <div className="mt-5 space-y-3">
      {!ctx.enabled && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Sending isn&apos;t switched on for your account yet. You can build campaigns, grow your list and send
            yourself tests in the meantime.
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm">
        <div className="min-w-[220px] flex-1">
          <div className="flex justify-between text-xs text-zinc-500">
            <span>Free emails this month</span>
            <span>
              {Math.min(ctx.usedThisMonth, ctx.freePerMonth).toLocaleString()} / {ctx.freePerMonth.toLocaleString()}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-100">
            <div className="h-full rounded-full bg-indigo-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="text-xs text-zinc-500">
          Then <span className="font-semibold text-zinc-800">{formatMinor(ctx.pricePer1000Minor)}</span> per 1,000
          emails from your wallet
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Campaigns ─────────────────────────── */

const pctOf = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");

function CampaignsTab({ ctx }: { ctx?: EmailMarketingContext }) {
  const router = useRouter();
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const [picking, setPicking] = useState(false);
  const { data: campaigns, isLoading } = useQuery({
    queryKey: ["email-mkt", "campaigns", locationId],
    queryFn: () => emailMarketingClient.campaigns(locationId),
    refetchInterval: (q) =>
      (q.state.data as EmailCampaignSummary[] | undefined)?.some((c) => c.status === "SENDING") ? 5000 : false,
  });

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-800">Your campaigns</h2>
        <button
          onClick={() => setPicking(true)}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4" /> New campaign
        </button>
      </div>

      {isLoading ? (
        <div className="mt-10 flex justify-center text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : !campaigns?.length ? (
        <div className="mt-6 rounded-2xl border border-dashed border-zinc-300 bg-white px-6 py-12 text-center">
          <Mail className="mx-auto h-9 w-9 text-indigo-400" />
          <h3 className="mt-3 text-base font-semibold text-zinc-900">Send your first email campaign</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
            Pick a ready-made template (weekend offer, win-back, new dish…), add your own touch and send it to
            customers who asked to hear from you.
          </p>
          <button
            onClick={() => setPicking(true)}
            className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" /> Choose a template
          </button>
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-xl border border-zinc-200 bg-white">
          <div className="hidden grid-cols-[1fr_110px_90px_90px_90px] gap-3 border-b border-zinc-100 bg-zinc-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 md:grid">
            <span>Campaign</span>
            <span>Status</span>
            <span className="text-right">Sent</span>
            <span className="text-right">Opened</span>
            <span className="text-right">Clicked</span>
          </div>
          {campaigns.map((c) => (
            <Link
              key={c.id}
              href={`/dashboard/marketing/email/${c.id}`}
              className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-zinc-100 px-4 py-3 last:border-0 hover:bg-zinc-50 md:grid-cols-[1fr_110px_90px_90px_90px]"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-zinc-900">{c.name}</div>
                <div className="truncate text-xs text-zinc-500">
                  {c.subject || "No subject yet"}
                  {" · "}
                  {c.status === "SCHEDULED" && c.scheduledAt
                    ? `Scheduled ${new Date(c.scheduledAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`
                    : c.startedAt
                      ? new Date(c.startedAt).toLocaleDateString("en-GB", { dateStyle: "medium" })
                      : `Edited ${new Date(c.updatedAt).toLocaleDateString("en-GB", { dateStyle: "medium" })}`}
                </div>
                {c.lastError && c.status !== "SENT" && (
                  <div className="mt-0.5 truncate text-xs text-rose-600">{c.lastError}</div>
                )}
              </div>
              <div>
                <EmailStatusBadge status={c.status} />
              </div>
              <div className="hidden text-right text-sm tabular-nums text-zinc-700 md:block">
                {c.sentCount ? c.sentCount.toLocaleString() : "—"}
              </div>
              <div className="hidden text-right text-sm tabular-nums text-zinc-700 md:block">
                {c.sentCount ? pctOf(c.openCount, c.sentCount) : "—"}
              </div>
              <div className="hidden text-right text-sm tabular-nums text-zinc-700 md:block">
                {c.sentCount ? pctOf(c.clickCount, c.sentCount) : "—"}
              </div>
            </Link>
          ))}
        </div>
      )}

      {picking && (
        <TemplatePicker
          ctx={ctx}
          onClose={() => setPicking(false)}
          onCreated={(id) => router.push(`/dashboard/marketing/email/${id}`)}
        />
      )}
    </div>
  );
}

function TemplatePicker({
  ctx,
  onClose,
  onCreated,
}: {
  ctx?: EmailMarketingContext;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const brands = ctx?.brands ?? [];
  // brands[0] is the selected shop's own brand (the API sorts it first).
  const [brandId, setBrandId] = useState<string>(brands[0]?.id ?? "");
  const brand = brands.find((b) => b.id === brandId) ?? brands[0];
  const { data: products } = useQuery({
    queryKey: ["email-mkt", "products", brand?.id, locationId],
    queryFn: () => emailMarketingClient.products({ brandId: brand?.id, locationId }),
    enabled: !!brand?.id,
  });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (templateId: string) =>
      emailMarketingClient.create({ templateId, brandId: brand?.id ?? null, locationId }),
    onSuccess: (c) => onCreated(c.id),
    onError: (e) => setError(apiErrorMessage(e)),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8">
      <div className="w-full max-w-5xl rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-zinc-900">Choose a template</h2>
            <p className="text-xs text-zinc-500">Everything is editable: text, photos, offer, colours.</p>
          </div>
          <div className="flex items-center gap-2">
            {brands.length > 1 && (
              <select
                value={brand?.id ?? ""}
                onChange={(e) => setBrandId(e.target.value)}
                className="rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm"
                aria-label="Brand"
              >
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
            <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        {error && <div className="mx-5 mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          {EMAIL_TEMPLATES.map((t) => (
            <button
              key={t.id}
              disabled={create.isPending}
              onClick={() => create.mutate(t.id)}
              className="group overflow-hidden rounded-xl border border-zinc-200 text-left transition hover:border-indigo-400 hover:shadow-md disabled:opacity-60"
            >
              <TemplateThumb
                templateId={t.id}
                brandName={brand?.name ?? "Your restaurant"}
                logoUrl={brand?.logoUrl ?? null}
                primaryColor={ctx?.primaryColor ?? null}
                products={(products ?? []).filter((p) => p.imageUrl).slice(0, 4)}
              />
              <div className="border-t border-zinc-100 px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
                  {create.isPending && create.variables === t.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t.name}
                </div>
                <div className="text-xs text-zinc-500">{t.description}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function TemplateThumb(props: {
  templateId: string;
  brandName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  products: EmailProduct[];
}) {
  const html = useMemo(() => {
    const t = EMAIL_TEMPLATES.find((x) => x.id === props.templateId)!;
    const design = t.build({ brandName: props.brandName, primaryColor: props.primaryColor, products: props.products });
    return renderEmail(design, {
      brandName: props.brandName,
      logoUrl: props.logoUrl,
      storefrontUrl: "#",
      unsubscribeUrl: "#",
      firstName: "Sam",
      poweredBy: POWERED_BY,
    }).html;
  }, [props.templateId, props.brandName, props.logoUrl, props.primaryColor, props.products]);
  return (
    <div className="relative h-56 overflow-hidden bg-zinc-100">
      <iframe
        title=""
        srcDoc={html}
        sandbox=""
        tabIndex={-1}
        className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
        style={{ width: 640, height: 1100, transform: "scale(0.36)" }}
      />
    </div>
  );
}

/* ─────────────────────────── Audience ─────────────────────────── */

const CONTACT_STATUS: Record<EmailContactStatus, { label: string; cls: string }> = {
  SUBSCRIBED: { label: "Subscribed", cls: "bg-emerald-100 text-emerald-800" },
  UNSUBSCRIBED: { label: "Unsubscribed", cls: "bg-zinc-100 text-zinc-600" },
  BOUNCED: { label: "Bounced", cls: "bg-amber-100 text-amber-800" },
  COMPLAINED: { label: "Marked as spam", cls: "bg-rose-100 text-rose-800" },
};

const SOURCE_LABEL: Record<string, string> = {
  ONLINE: "Online ordering",
  POS: "In store (POS)",
  DIRECT: "Direct",
  WHATSAPP: "WhatsApp",
  VOICE: "AI phone line",
};

function AudienceTab() {
  const qc = useQueryClient();
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const [status, setStatus] = useState<string>("");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState<null | "orders" | "file" | "one">(null);
  const { data, isLoading } = useQuery({
    queryKey: ["email-mkt", "contacts", locationId, status, search],
    queryFn: () => emailMarketingClient.contacts({ locationId, status, search, limit: 200 }),
  });
  const unsub = useMutation({
    mutationFn: (id: string) => emailMarketingClient.unsubscribeContact(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-mkt", "contacts"] }),
  });

  const counts = data?.byStatus ?? {};
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 px-4 py-3 text-sm text-indigo-950">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
          <p>
            Your list grows by itself: customers who tick <b>&ldquo;Email me offers&rdquo;</b> at online checkout are
            added automatically. Only subscribed customers are ever emailed, and anyone who unsubscribes, bounces or
            reports spam is never emailed again.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(Object.keys(CONTACT_STATUS) as EmailContactStatus[]).map((s) => (
          <button
            key={s}
            onClick={() => setStatus(status === s ? "" : s)}
            className={cn(
              "rounded-xl border bg-white px-4 py-3 text-left transition",
              status === s ? "border-indigo-500 ring-1 ring-indigo-500" : "border-zinc-200 hover:border-zinc-300",
            )}
          >
            <div className="text-2xl font-bold tabular-nums text-zinc-900">{(counts[s] ?? 0).toLocaleString()}</div>
            <div className="text-xs text-zinc-500">{CONTACT_STATUS[s].label}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setAdding("orders")}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
        >
          <Users className="h-4 w-4 text-indigo-600" /> Import past customers
        </button>
        <button
          onClick={() => setAdding("file")}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
        >
          <Upload className="h-4 w-4 text-indigo-600" /> Upload a list
        </button>
        <button
          onClick={() => setAdding("one")}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
        >
          <UserPlus className="h-4 w-4 text-indigo-600" /> Add one
        </button>
        <div className="relative ml-auto min-w-[200px] flex-1 sm:max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-zinc-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search email or name"
            className="w-full rounded-lg border border-zinc-200 py-2 pl-8 pr-3 text-sm"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
        {isLoading ? (
          <div className="flex justify-center py-10 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : !data?.items.length ? (
          <div className="px-4 py-10 text-center text-sm text-zinc-500">No contacts here yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2">Contact</th>
                <th className="hidden px-4 py-2 sm:table-cell">How they joined</th>
                <th className="hidden px-4 py-2 md:table-cell">Last emailed</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id} className="border-t border-zinc-100">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-zinc-900">
                      {[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}
                    </div>
                    <div className="text-xs text-zinc-500">{c.email}</div>
                  </td>
                  <td className="hidden px-4 py-2.5 text-xs text-zinc-600 sm:table-cell">
                    {consentLabel(c.consentSource)}
                    {c.consentAt && (
                      <div className="text-zinc-400">{new Date(c.consentAt).toLocaleDateString("en-GB")}</div>
                    )}
                  </td>
                  <td className="hidden px-4 py-2.5 text-xs text-zinc-600 md:table-cell">
                    {c.lastEmailedAt ? new Date(c.lastEmailedAt).toLocaleDateString("en-GB") : "Never"}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", CONTACT_STATUS[c.status].cls)}>
                      {CONTACT_STATUS[c.status].label}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {c.status === "SUBSCRIBED" && (
                      <button
                        onClick={() => {
                          if (confirm(`Unsubscribe ${c.email}? Only they can opt back in.`)) unsub.mutate(c.id);
                        }}
                        className="text-xs font-medium text-zinc-500 hover:text-rose-600"
                      >
                        Unsubscribe
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {data && data.items.length >= 200 && (
        <p className="text-center text-xs text-zinc-500">Showing the latest 200. Search to find someone specific.</p>
      )}

      {adding && <AddContacts mode={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}

function consentLabel(src: string | null): string {
  if (!src) return "—";
  if (src === "checkout") return "Ticked at checkout";
  if (src === "manual") return "Added by you";
  if (src === "resubscribe") return "Re-subscribed";
  if (src.startsWith("import:asserted:")) return `Imported · ${SOURCE_LABEL[src.split(":")[2] ?? ""] ?? "orders"}`;
  if (src.startsWith("import")) return "Imported list";
  return src;
}

function AddContacts({ mode, onClose }: { mode: "orders" | "file" | "one"; onClose: () => void }) {
  const qc = useQueryClient();
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const [consent, setConsent] = useState(false);
  const [report, setReport] = useState<EmailImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Past customers
  const { data: sources } = useQuery({
    queryKey: ["email-mkt", "sources", locationId],
    queryFn: () => emailMarketingClient.sources(locationId),
    enabled: mode === "orders",
  });
  const [picked, setPicked] = useState<string[]>(["ONLINE"]);

  // File / paste
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<EmailRow[] | null>(null);
  const [paste, setPaste] = useState("");

  // One
  const [one, setOne] = useState({ email: "", firstName: "", lastName: "" });

  const done = (r?: EmailImportReport) => {
    qc.invalidateQueries({ queryKey: ["email-mkt", "contacts"] });
    if (r) setReport(r);
    else onClose();
  };
  const run = useMutation({
    mutationFn: async () => {
      setError(null);
      if (mode === "orders") return emailMarketingClient.importFromOrders(picked, locationId, consent);
      if (mode === "file") {
        const list = rows ?? parseEmailText(paste);
        if (!list.length) throw new Error("No email addresses found.");
        return emailMarketingClient.importRows(list, locationId, consent);
      }
      await emailMarketingClient.addContact({ ...one, locationId });
      return undefined;
    },
    onSuccess: (r) => done(r as EmailImportReport | undefined),
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const title =
    mode === "orders" ? "Import past customers" : mode === "file" ? "Upload a list" : "Add a subscriber";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-base font-bold text-zinc-900">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {report ? (
          <div className="space-y-3 p-5">
            <div className="flex items-center gap-2 text-emerald-700">
              <CheckCircle2 className="h-5 w-5" />
              <span className="font-semibold">{(report.added + report.updated).toLocaleString()} contacts ready</span>
            </div>
            <ul className="space-y-1 text-sm text-zinc-600">
              <li>{report.added.toLocaleString()} new</li>
              <li>{report.updated.toLocaleString()} already on your list</li>
              {report.suppressed > 0 && (
                <li>{report.suppressed.toLocaleString()} skipped: they unsubscribed or bounced before</li>
              )}
              {report.invalid > 0 && <li>{report.invalid.toLocaleString()} invalid addresses ignored</li>}
              {report.duplicatesInFile > 0 && <li>{report.duplicatesInFile.toLocaleString()} duplicates in the file</li>}
            </ul>
            <button onClick={onClose} className="w-full rounded-lg bg-indigo-600 py-2 text-sm font-semibold text-white">
              Done
            </button>
          </div>
        ) : (
          <div className="space-y-4 p-5">
            {mode === "orders" && (
              <>
                <p className="text-sm text-zinc-600">
                  Customers who ordered through your own channels and left an email address. Marketplace customers
                  (Uber Eats, Deliveroo, Just Eat…) belong to the marketplace and can&apos;t be emailed.
                </p>
                <div className="space-y-2">
                  {(sources ?? []).map((s) => (
                    <label
                      key={s.source}
                      className="flex cursor-pointer items-center justify-between rounded-lg border border-zinc-200 px-3 py-2 text-sm"
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={picked.includes(s.source)}
                          onChange={(e) =>
                            setPicked((p) => (e.target.checked ? [...p, s.source] : p.filter((x) => x !== s.source)))
                          }
                        />
                        {SOURCE_LABEL[s.source] ?? s.source}
                      </span>
                      <span className="text-xs tabular-nums text-zinc-500">{s.count.toLocaleString()} with email</span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {mode === "file" && (
              <>
                <div
                  onClick={() => fileRef.current?.click()}
                  className="cursor-pointer rounded-xl border-2 border-dashed border-zinc-300 px-4 py-6 text-center hover:border-indigo-400"
                >
                  <Upload className="mx-auto h-6 w-6 text-zinc-400" />
                  <div className="mt-1 text-sm font-medium text-zinc-800">
                    {rows ? `${rows.length.toLocaleString()} addresses found` : "Choose a CSV or Excel file"}
                  </div>
                  <div className="text-xs text-zinc-500">We look for an email column, plus names if there are any.</div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,.xlsx,.xls,text/csv"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      try {
                        setRows(await parseEmailFile(f));
                      } catch {
                        setError("Couldn't read that file.");
                      }
                    }}
                  />
                </div>
                {!rows && (
                  <div>
                    <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-zinc-600">
                      <ClipboardPaste className="h-3.5 w-3.5" /> Or paste, one per line
                    </div>
                    <textarea
                      value={paste}
                      onChange={(e) => setPaste(e.target.value)}
                      rows={4}
                      placeholder={"Sam Jones, sam@example.com\njo@example.com"}
                      className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm"
                    />
                  </div>
                )}
              </>
            )}

            {mode === "one" && (
              <div className="space-y-2">
                <input
                  value={one.email}
                  onChange={(e) => setOne({ ...one, email: e.target.value })}
                  placeholder="Email address"
                  type="email"
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={one.firstName}
                    onChange={(e) => setOne({ ...one, firstName: e.target.value })}
                    placeholder="First name"
                    className="rounded-lg border border-zinc-200 px-3 py-2 text-sm"
                  />
                  <input
                    value={one.lastName}
                    onChange={(e) => setOne({ ...one, lastName: e.target.value })}
                    placeholder="Last name"
                    className="rounded-lg border border-zinc-200 px-3 py-2 text-sm"
                  />
                </div>
              </div>
            )}

            {mode !== "one" && (
              <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-zinc-50 px-3 py-2.5 text-xs text-zinc-700">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I confirm these customers agreed to receive marketing emails from us, for example by opting in
                  when they ordered. Sending to people who didn&apos;t agree can break the law (UK GDPR / PECR).
                </span>
              </label>
            )}
            {mode === "one" && (
              <p className="text-xs text-zinc-500">Only add someone who has asked to receive your emails.</p>
            )}

            {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

            <button
              onClick={() => run.mutate()}
              disabled={run.isPending || (mode !== "one" && !consent) || (mode === "orders" && !picked.length)}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {run.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === "one" ? "Add subscriber" : "Import"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

