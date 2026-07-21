"use client";

// SMS Marketing — build a consented audience, then broadcast. Consent-first:
// only opted-in contacts are messaged, every text carries a STOP footer, and
// replies of STOP opt people out automatically. Sends are billed from the SMS
// wallet per Twilio segment, with a live cost estimate before you send.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare,
  Users,
  Upload,
  Send,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Wallet as WalletIcon,
  Plus,
  Beaker,
  History,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import {
  marketingSmsClient,
  type MarketingContact,
  type ImportReport,
} from "@/lib/api/marketing-sms.client";
import { formatGbp } from "@/lib/api/wallet.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { estimateSegments } from "@/lib/marketing-sms/segments";
import {
  parseContactFile,
  parsePastedText,
  type ParsedContacts,
} from "@/lib/marketing-sms/parse-contacts";
import { cn } from "@/lib/utils";

type Tab = "compose" | "contacts" | "history";

export default function SmsMarketingPage() {
  const [tab, setTab] = useState<Tab>("compose");
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const { data: contactStats } = useQuery({
    queryKey: ["sms-contacts", "stats", locationId],
    queryFn: () => marketingSmsClient.contacts({ limit: 1, locationId }),
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-100 text-violet-700">
            <MessageSquare className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-zinc-900">SMS Marketing</h1>
            <p className="text-sm text-zinc-500">
              {contactStats
                ? `${contactStats.optedIn.toLocaleString()} opted-in of ${contactStats.total.toLocaleString()} contacts`
                : "Reach your customers by text"}
            </p>
          </div>
        </div>
        <Link
          href="/dashboard/wallet"
          className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          <WalletIcon className="h-4 w-4 text-emerald-600" /> SMS Wallet
        </Link>
      </div>

      {/* Tabs */}
      <div className="mt-6 flex gap-1 border-b border-zinc-200">
        {(
          [
            ["compose", "Compose", Send],
            ["contacts", "Contacts", Users],
            ["history", "History", History],
          ] as [Tab, string, any][]
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition",
              tab === key
                ? "border-violet-600 text-violet-700"
                : "border-transparent text-zinc-500 hover:text-zinc-800",
            )}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === "compose" && <ComposeTab />}
        {tab === "contacts" && <ContactsTab />}
        {tab === "history" && <HistoryTab />}
      </div>
    </div>
  );
}

/* ─────────────────────────── Compose ─────────────────────────── */

function ComposeTab() {
  const qc = useQueryClient();
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const [name, setName] = useState("");
  const [header, setHeader] = useState("");
  const [body, setBody] = useState("");
  const [sources, setSources] = useState<string[]>([]);
  const [testPhone, setTestPhone] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const { data: channels } = useQuery({
    queryKey: ["sms-channels", locationId],
    queryFn: () => marketingSmsClient.channels(locationId),
  });

  // Debounce message/audience → live preview.
  const [debounced, setDebounced] = useState({ header, body, sources });
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ header, body, sources }), 400);
    return () => clearTimeout(t);
  }, [header, body, sources]);

  const { data: preview, isFetching: previewing } = useQuery({
    queryKey: ["sms-preview", debounced, locationId],
    queryFn: () =>
      marketingSmsClient.preview({
        senderHeader: debounced.header,
        body: debounced.body,
        audience: { sources: debounced.sources },
        locationId,
      }),
    enabled: debounced.body.trim().length > 0,
  });

  // Local segment counter (matches server). Includes header + STOP footer.
  const composed = useMemo(() => {
    const h = header.trim();
    let m = h ? `${h}: ${body}` : body;
    if (!/\bSTOP\b/i.test(m)) m = `${m}\nReply STOP to opt out`;
    return m.replace(/\{\{\s*(first_?name|name)\s*\}\}/gi, "there");
  }, [header, body]);
  const seg = estimateSegments(composed);

  const save = useMutation({
    mutationFn: () =>
      marketingSmsClient.saveCampaign({
        name: name || "Untitled campaign",
        senderHeader: header,
        body,
        audience: { sources },
        locationId,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sms-campaigns"] }),
  });

  const test = useMutation({
    mutationFn: () =>
      marketingSmsClient.testSend({
        phone: testPhone,
        senderHeader: header,
        body,
        locationId,
      }),
  });

  const send = useMutation({
    mutationFn: async () => {
      const c = await marketingSmsClient.saveCampaign({
        name: name || "Untitled campaign",
        senderHeader: header,
        body,
        audience: { sources },
        locationId,
      });
      return marketingSmsClient.send(c.id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sms-campaigns"] });
      qc.invalidateQueries({ queryKey: ["wallet"] });
    },
  });

  const insertTag = (tag: string) => {
    const el = bodyRef.current;
    if (!el) return setBody((b) => b + tag);
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + tag + body.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + tag.length;
    });
  };

  const canSend =
    !!preview && preview.recipients > 0 && preview.canAfford && !send.isPending;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      {/* Composer */}
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500">
            Campaign name (internal)
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Friday 2-for-1 pizza"
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500">
            Sender name (shown at the start of the text)
          </label>
          <input
            value={header}
            onChange={(e) => setHeader(e.target.value)}
            placeholder="e.g. Pizza Uno"
            maxLength={40}
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs font-medium text-zinc-500">Message</label>
            <button
              type="button"
              onClick={() => insertTag("{{name}}")}
              className="rounded bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-200"
            >
              + Insert customer name
            </button>
          </div>
          <textarea
            ref={bodyRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            placeholder="Hi {{name}}, get 2-for-1 on all pizzas this Friday. Order at pizzauno.co.uk"
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-zinc-500">
            <span>
              {seg.length} chars · {seg.encoding} ·{" "}
              <span className="font-semibold text-zinc-700">
                {seg.segments} segment{seg.segments > 1 ? "s" : ""}
              </span>{" "}
              / message
            </span>
            <span>{seg.remaining} left in segment</span>
          </div>
        </div>

        {/* Live preview of the actual text */}
        <div className="rounded-lg bg-zinc-900 p-4">
          <p className="text-[11px] uppercase tracking-wide text-zinc-500">Preview</p>
          <div className="mt-2 max-w-xs rounded-2xl rounded-bl-sm bg-zinc-700 px-3 py-2 text-sm text-white">
            {composed || "Your message will appear here…"}
          </div>
          <p className="mt-2 flex items-center gap-1 text-[11px] text-zinc-500">
            <ShieldCheck className="h-3 w-3" /> A “Reply STOP to opt out” line is added
            automatically for compliance.
          </p>
        </div>

        {/* Test send */}
        <div className="flex items-end gap-2 rounded-lg border border-zinc-200 p-3">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-zinc-500">
              Send a test to yourself
            </label>
            <input
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="07… your mobile"
              className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm"
            />
          </div>
          <button
            onClick={() => test.mutate()}
            disabled={!testPhone.trim() || !body.trim() || test.isPending}
            className="flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            {test.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Beaker className="h-4 w-4" />
            )}
            Test
          </button>
        </div>
        {test.isSuccess && (
          <p className="text-xs text-emerald-600">✓ Test sent.</p>
        )}
        {test.isError && (
          <p className="text-xs text-red-600">
            {(test.error as any)?.response?.data?.message ?? "Test failed."}
          </p>
        )}
      </div>

      {/* Audience + send */}
      <div className="space-y-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-4">
          <p className="text-sm font-semibold text-zinc-900">Audience</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            Opted-in contacts only. Leave channels unticked to message everyone
            who’s opted in.
          </p>
          <div className="mt-3 space-y-1.5">
            {channels?.map((c) => (
              <label
                key={c.channel}
                className="flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-zinc-50"
              >
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={sources.includes(c.channel)}
                    onChange={(e) =>
                      setSources((s) =>
                        e.target.checked
                          ? [...s, c.channel]
                          : s.filter((x) => x !== c.channel),
                      )
                    }
                    className="rounded border-zinc-300"
                  />
                  {c.channel}
                </span>
                <span className="text-xs text-zinc-400">{c.count}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Cost + send */}
        <div className="rounded-xl border border-zinc-200 bg-white p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-500">Recipients</span>
            <span className="font-semibold text-zinc-900">
              {previewing ? "…" : (preview?.recipients ?? 0).toLocaleString()}
            </span>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-sm">
            <span className="text-zinc-500">Est. cost</span>
            <span className="font-semibold text-zinc-900">
              {formatGbp(preview?.costMinor ?? 0)}
            </span>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-sm">
            <span className="text-zinc-500">Wallet balance</span>
            <span
              className={cn(
                "font-semibold",
                preview && !preview.canAfford ? "text-amber-600" : "text-zinc-900",
              )}
            >
              {formatGbp(preview?.balanceMinor ?? 0)}
            </span>
          </div>

          {preview && !preview.canAfford && preview.recipients > 0 && (
            <Link
              href="/dashboard/wallet"
              className="mt-3 flex items-center justify-center gap-1.5 rounded-lg bg-amber-500 py-2 text-sm font-semibold text-white hover:bg-amber-600"
            >
              <WalletIcon className="h-4 w-4" /> Top up to send
            </Link>
          )}

          <button
            onClick={() => send.mutate()}
            disabled={!canSend}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {send.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Send to {(preview?.recipients ?? 0).toLocaleString()}
          </button>

          <button
            onClick={() => save.mutate()}
            disabled={!body.trim() || save.isPending}
            className="mt-2 w-full rounded-lg border border-zinc-200 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
          >
            Save draft
          </button>

          {send.isSuccess && (
            <p className="mt-2 flex items-center gap-1 text-xs text-emerald-600">
              <CheckCircle2 className="h-3.5 w-3.5" /> Sending started to{" "}
              {send.data?.recipients} contacts — track it in History.
            </p>
          )}
          {send.isError && (
            <p className="mt-2 text-xs text-red-600">
              {(send.error as any)?.response?.data?.message ?? "Couldn’t send."}
            </p>
          )}
          {save.isSuccess && !send.isSuccess && (
            <p className="mt-2 text-xs text-emerald-600">✓ Draft saved.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Contacts ─────────────────────────── */

function consentPill(status: string) {
  if (status === "OPTED_IN")
    return "bg-emerald-100 text-emerald-700";
  if (status === "OPTED_OUT") return "bg-red-100 text-red-600";
  return "bg-zinc-100 text-zinc-500";
}

function ContactsTab() {
  const qc = useQueryClient();
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const [consent, setConsent] = useState("");
  const [search, setSearch] = useState("");
  const [showImport, setShowImport] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["sms-contacts", consent, search, locationId],
    queryFn: () =>
      marketingSmsClient.contacts({
        consent: consent || undefined,
        search: search || undefined,
        limit: 300,
        locationId,
      }),
  });

  const toggle = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "OPTED_IN" | "OPTED_OUT" }) =>
      marketingSmsClient.setConsent(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sms-contacts"] }),
  });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or number"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm"
          />
          <select
            value={consent}
            onChange={(e) => setConsent(e.target.value)}
            className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
          >
            <option value="">All consent</option>
            <option value="OPTED_IN">Opted in</option>
            <option value="OPTED_OUT">Opted out</option>
            <option value="UNKNOWN">Unknown</option>
          </select>
        </div>
        <button
          onClick={() => setShowImport(true)}
          className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-700"
        >
          <Upload className="h-4 w-4" /> Import contacts
        </button>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-zinc-200 bg-white">
        {isLoading ? (
          <div className="py-12 text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-zinc-300" />
          </div>
        ) : !data?.items.length ? (
          <p className="px-4 py-12 text-center text-sm text-zinc-400">
            No contacts yet. Import from your channels or upload a list.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Number</th>
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 font-medium">Consent</th>
                <th className="px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {data.items.map((c: MarketingContact) => (
                <tr key={c.id}>
                  <td className="px-4 py-2 text-zinc-800">
                    {[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-zinc-600">{c.phone}</td>
                  <td className="px-4 py-2 text-zinc-500">{c.source ?? "—"}</td>
                  <td className="px-4 py-2">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                        consentPill(c.consentStatus),
                      )}
                    >
                      {c.consentStatus.replace("_", " ").toLowerCase()}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-3">
                      {c.consentStatus !== "OPTED_IN" && (
                        <button
                          onClick={() => toggle.mutate({ id: c.id, status: "OPTED_IN" })}
                          disabled={toggle.isPending}
                          className="text-xs font-medium text-zinc-400 hover:text-emerald-600 disabled:opacity-50"
                        >
                          Opt in
                        </button>
                      )}
                      {c.consentStatus !== "OPTED_OUT" && (
                        <button
                          onClick={() => toggle.mutate({ id: c.id, status: "OPTED_OUT" })}
                          disabled={toggle.isPending}
                          className="text-xs text-zinc-400 hover:text-red-600 disabled:opacity-50"
                        >
                          Opt out
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showImport && <ImportWizard onClose={() => setShowImport(false)} />}
    </div>
  );
}

/* ─────────────────────────── Import wizard ─────────────────────────── */

function ImportWizard({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const [mode, setMode] = useState<"channels" | "file">("channels");
  const [report, setReport] = useState<ImportReport | null>(null);

  // From-channels state
  const [picked, setPicked] = useState<string[]>([]);
  const [consentedOnly, setConsentedOnly] = useState(true);
  const { data: channels } = useQuery({
    queryKey: ["sms-channels", locationId],
    queryFn: () => marketingSmsClient.channels(locationId),
  });

  // File / paste state
  const [parsed, setParsed] = useState<ParsedContacts | null>(null);
  const [paste, setPaste] = useState("");
  const [assertConsent, setAssertConsent] = useState(false);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");

  const done = (r: ImportReport) => {
    setReport(r);
    qc.invalidateQueries({ queryKey: ["sms-contacts"] });
    qc.invalidateQueries({ queryKey: ["sms-channels"] });
  };

  const importChannels = useMutation({
    mutationFn: () => marketingSmsClient.importFromCustomers(picked, consentedOnly, locationId),
    onSuccess: done,
  });

  const importRows = useMutation({
    mutationFn: () =>
      marketingSmsClient.importRows(
        parsed?.rows ?? [],
        fileName ? "FILE" : "PASTE",
        assertConsent,
        locationId,
      ),
    onSuccess: done,
  });

  const onFile = async (file: File) => {
    setParseErr(null);
    setFileName(file.name);
    try {
      setParsed(await parseContactFile(file));
    } catch (e: any) {
      setParseErr("Couldn’t read that file. Try CSV, or export your sheet as CSV/Excel.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-zinc-900">Import contacts</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700">
            ✕
          </button>
        </div>

        {report ? (
          <div className="mt-4">
            <div className="flex items-center gap-2 text-emerald-700">
              <CheckCircle2 className="h-5 w-5" />
              <span className="font-semibold">Import complete</span>
            </div>
            <ul className="mt-3 space-y-1 text-sm text-zinc-600">
              <li>✓ {report.added} new contacts added</li>
              <li>· {report.updated} existing updated</li>
              <li>· {report.duplicatesInFile} duplicates skipped</li>
              {report.suppressed > 0 && (
                <li>· {report.suppressed} kept opted-out (suppressed)</li>
              )}
              {report.invalid > 0 && (
                <li>· {report.invalid} invalid / no consent skipped</li>
              )}
            </ul>
            <button
              onClick={onClose}
              className="mt-4 w-full rounded-lg bg-violet-600 py-2 text-sm font-semibold text-white hover:bg-violet-700"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="mt-4 flex gap-1 rounded-lg bg-zinc-100 p-1">
              {(
                [
                  ["channels", "From your customers"],
                  ["file", "Upload / paste"],
                ] as [typeof mode, string][]
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setMode(k)}
                  className={cn(
                    "flex-1 rounded-md py-1.5 text-sm font-medium transition",
                    mode === k ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === "channels" ? (
              <div className="mt-4">
                <p className="text-xs text-zinc-500">
                  Pull customers who ordered through each channel.
                </p>
                <div className="mt-2 grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto">
                  {channels?.map((c) => (
                    <label
                      key={c.channel}
                      className="flex cursor-pointer items-center justify-between rounded-md border border-zinc-200 px-2 py-1.5 text-sm hover:bg-zinc-50"
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={picked.includes(c.channel)}
                          onChange={(e) =>
                            setPicked((s) =>
                              e.target.checked
                                ? [...s, c.channel]
                                : s.filter((x) => x !== c.channel),
                            )
                          }
                        />
                        {c.channel}
                      </span>
                      <span className="text-xs text-zinc-400">{c.count}</span>
                    </label>
                  ))}
                </div>
                <label className="mt-3 flex items-center gap-2 text-sm text-zinc-700">
                  <input
                    type="checkbox"
                    checked={consentedOnly}
                    onChange={(e) => setConsentedOnly(e.target.checked)}
                  />
                  Only customers who ticked marketing consent
                </label>
                <p className="mt-1 flex items-start gap-1 text-[11px] text-zinc-400">
                  <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />
                  Without consent, contacts import as “unknown” and won’t be
                  messaged until you opt them in.
                </p>
                {importChannels.isError && (
                  <p className="mt-2 text-xs text-red-600">
                    {(importChannels.error as any)?.response?.data?.message ??
                      "Import failed."}
                  </p>
                )}
                <button
                  onClick={() => importChannels.mutate()}
                  disabled={!picked.length || importChannels.isPending}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                >
                  {importChannels.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Import selected channels
                </button>
              </div>
            ) : (
              <div className="mt-4">
                <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-zinc-300 py-6 text-center hover:border-violet-400">
                  <Upload className="h-6 w-6 text-zinc-400" />
                  <span className="mt-1 text-sm font-medium text-zinc-700">
                    {fileName || "Choose a CSV, Excel or Google Sheets file"}
                  </span>
                  <span className="text-[11px] text-zinc-400">
                    .csv · .xlsx · .xls (Google Sheets: File → Download)
                  </span>
                  <input
                    type="file"
                    accept=".csv,.xlsx,.xls,text/csv"
                    className="hidden"
                    onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
                  />
                </label>

                <div className="mt-3">
                  <label className="mb-1 block text-xs font-medium text-zinc-500">
                    …or paste numbers (one per line, or “Name, Number”)
                  </label>
                  <textarea
                    value={paste}
                    onChange={(e) => {
                      setPaste(e.target.value);
                      setFileName("");
                      setParsed(e.target.value.trim() ? parsePastedText(e.target.value) : null);
                    }}
                    rows={4}
                    placeholder={"John Smith, 07700 900123\n07700 900124"}
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
                  />
                </div>

                {parseErr && <p className="mt-2 text-xs text-red-600">{parseErr}</p>}
                {parsed && (
                  <p className="mt-2 text-xs text-zinc-500">
                    Found <span className="font-semibold">{parsed.rows.length}</span>{" "}
                    numbers{parsed.detectedColumns.phone
                      ? ` (column “${parsed.detectedColumns.phone}”)`
                      : ""}
                    . Duplicates &amp; invalid numbers are removed on import.
                  </p>
                )}

                <label className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                  <input
                    type="checkbox"
                    checked={assertConsent}
                    onChange={(e) => setAssertConsent(e.target.checked)}
                    className="mt-0.5"
                  />
                  I confirm these people have opted in to receive marketing texts
                  from us (required by UK law).
                </label>

                {importRows.isError && (
                  <p className="mt-2 text-xs text-red-600">
                    {(importRows.error as any)?.response?.data?.message ?? "Import failed."}
                  </p>
                )}
                <button
                  onClick={() => importRows.mutate()}
                  disabled={!parsed?.rows.length || !assertConsent || importRows.isPending}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                >
                  {importRows.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Import {parsed?.rows.length ?? 0} contacts
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── History ─────────────────────────── */

function HistoryTab() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const { data, isLoading } = useQuery({
    queryKey: ["sms-campaigns", locationId],
    queryFn: () => marketingSmsClient.campaigns(locationId),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((c: any) => c.status === "SENDING") ? 3000 : false,
  });

  if (isLoading)
    return <Loader2 className="mx-auto mt-8 h-6 w-6 animate-spin text-zinc-300" />;
  if (!data?.length)
    return (
      <p className="py-12 text-center text-sm text-zinc-400">
        No campaigns yet. Compose one to get started.
      </p>
    );

  return (
    <div className="space-y-2">
      {data.map((c) => (
        <div
          key={c.id}
          className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-4"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate font-medium text-zinc-900">{c.name}</p>
              <StatusBadge status={c.status} />
            </div>
            <p className="mt-0.5 truncate text-xs text-zinc-500">{c.body}</p>
          </div>
          <div className="ml-4 shrink-0 text-right">
            <p className="text-sm font-semibold text-zinc-900">
              {c.sentCount}/{c.recipientCount} sent
            </p>
            <p className="text-xs text-zinc-400">
              {formatGbp(c.costMinor)}
              {c.failedCount > 0 ? ` · ${c.failedCount} failed` : ""}
              {c.skippedCount > 0 ? ` · ${c.skippedCount} skipped` : ""}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    DRAFT: "bg-zinc-100 text-zinc-500",
    SENDING: "bg-blue-100 text-blue-700",
    SENT: "bg-emerald-100 text-emerald-700",
    FAILED: "bg-red-100 text-red-600",
  };
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        map[status] ?? map.DRAFT,
      )}
    >
      {status === "SENDING" && <Loader2 className="h-3 w-3 animate-spin" />}
      {status === "SENT" && <CheckCircle2 className="h-3 w-3" />}
      {status === "FAILED" && <XCircle className="h-3 w-3" />}
      {status.toLowerCase()}
    </span>
  );
}
