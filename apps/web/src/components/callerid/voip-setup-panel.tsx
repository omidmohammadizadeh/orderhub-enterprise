"use client";

// What to send the shop's phone provider.
//
// Before this, connecting a shop meant reading a location id out of a browser
// URL, pasting a secret by hand, and writing the instructions from memory —
// which is how a provider ended up posting on EVERY call event and staff got
// a caller card when a call ENDED, minutes after they had hung up.
//
// So the wording is not a placeholder. Three things have to be in it every
// time, and each one is here because getting it wrong has cost us a callout:
//   • the INCOMING/RINGING event only — never answered, ended, missed or
//     voicemail, or the till pops up for calls that are already over;
//   • the CALLER's number, not the shop's own;
//   • the key in the x-voip-key header, not in the URL, because URLs are
//     logged by every proxy they pass through.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Phone,
  RefreshCw,
  Webhook,
} from "lucide-react";
import {
  simultaneousRingProviderMessage,
  webhookProviderMessage,
} from "@orderhub/shared";
import { callerIdClient, type CallerIdRing } from "@/lib/api/caller-id.client";
import { useAuthStore } from "@/stores/auth.store";

/** Mirrors CALLER_ID_SETUP_ROLES on the API. The server is the gate; this
 *  only decides whether we ask for a key we would not be given. */
const KEY_ROLES = new Set([
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "MANAGER",
  "DARK_KITCHEN_MANAGER",
]);

export function VoipSetupPanel({ locationId }: { locationId: string | null }) {
  const role = useAuthStore((s) => s.user?.role);
  const maySeeKey = !!role && KEY_ROLES.has(role);
  const qc = useQueryClient();
  const [revealed, setRevealed] = useState(false);

  const setupQuery = useQuery({
    queryKey: ["caller-id", "setup", locationId],
    queryFn: () => callerIdClient.setup(locationId!),
    enabled: !!locationId && maySeeKey,
    // The ring log is the "did the provider's test call land?" light, so it
    // has to move without a page reload while someone is on the phone to them.
    refetchInterval: 10_000,
  });

  const mint = useMutation({
    mutationFn: () => callerIdClient.mintToken(locationId!),
    onSuccess: () => {
      setRevealed(true);
      qc.invalidateQueries({ queryKey: ["caller-id", "setup", locationId] });
    },
  });

  const testRing = useMutation({
    mutationFn: () => callerIdClient.testRing(locationId!, TEST_NUMBER),
  });

  // Reset the reveal when the operator switches shop — the key on screen must
  // always be the key for the shop named above it.
  useEffect(() => setRevealed(false), [locationId]);

  const setup = setupQuery.data;
  const token = setup?.token ?? null;

  const providerMessage = useMemo(
    () => (setup ? webhookProviderMessage(setup.url, token) : ""),
    [setup, token],
  );
  const ringMessage = useMemo(
    () => (setup ? simultaneousRingProviderMessage(setup.voiceNumber) : ""),
    [setup],
  );

  if (!locationId) {
    return (
      <Panel title="Connect the shop's phone provider">
        <p className="text-xs text-zinc-500">
          Pick ONE shop in the location switcher above — the address below is different for
          every shop.
        </p>
      </Panel>
    );
  }

  if (!maySeeKey) {
    return (
      <Panel title="Connect the shop's phone provider">
        <p className="text-xs text-zinc-500">
          The key that lets a phone provider ring this shop&apos;s tills isn&apos;t shown to
          your role. Ask an owner or manager to open this page and send it to the provider.
        </p>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── Route A: the provider can call a webhook ───────────────────── */}
      <Panel
        title="Route A — your provider can send a webhook (best)"
        icon={<Webhook className="h-3.5 w-3.5 text-zinc-400" />}
        subtitle="Instant, no phone number needed, and it works no matter who the shop's line is with."
      >
        {setupQuery.isLoading ? (
          <p className="text-xs text-zinc-400">Loading…</p>
        ) : setupQuery.isError ? (
          <p className="text-xs text-red-600">
            Couldn&apos;t load this shop&apos;s settings. Reload the page.
          </p>
        ) : setup ? (
          <>
            <Labelled label="Address to send the ring to (unique to this shop)">
              <CopyRow value={setup.url} />
            </Labelled>

            <Labelled label={`Key — send it in the "${setup.headerName}" header`}>
              {token ? (
                <div className="flex flex-wrap items-center gap-2">
                  <CopyRow
                    value={token}
                    display={revealed ? token : `${token.slice(0, 10)}${"•".repeat(18)}`}
                  />
                  <button
                    type="button"
                    onClick={() => setRevealed((v) => !v)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700"
                  >
                    {revealed ? (
                      <>
                        <EyeOff className="h-3.5 w-3.5" /> Hide
                      </>
                    ) : (
                      <>
                        <Eye className="h-3.5 w-3.5" /> Show
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => mint.mutate()}
                    disabled={mint.isPending}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Replace
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => mint.mutate()}
                    disabled={mint.isPending}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    {mint.isPending ? "Creating…" : "Create this shop's key"}
                  </button>
                  <span className="text-[11px] text-zinc-500">
                    {setup.sharedKeyEnabled
                      ? "This shop is on the old shared key. Creating its own key doesn't switch anything off — the old one keeps working until we retire it."
                      : "Needed before a provider can ring this shop's tills."}
                  </span>
                </div>
              )}
            </Labelled>

            <p className="text-[11px] text-zinc-500">
              The key belongs to <strong>this shop only</strong>. Whoever holds it can put a
              caller card on this shop&apos;s tills and nothing else — it can&apos;t read
              orders, customers or takings, and it can&apos;t touch another shop. If a provider
              stops working for the shop, press <strong>Replace</strong> and send the new one.
            </p>

            <Labelled label="Send this to the provider">
              <CopyBlock value={providerMessage} />
            </Labelled>
          </>
        ) : null}
      </Panel>

      {/* ── Route B: no webhook support ────────────────────────────────── */}
      <Panel
        title="Route B — your provider can't do webhooks"
        icon={<Phone className="h-3.5 w-3.5 text-zinc-400" />}
        subtitle="We give the shop a number. The provider rings it at the same time as the shop's own line; we never pick up, so there's nothing to pay per call."
      >
        {setup ? (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Check2
                ok={!!setup.voiceNumber}
                label="Number assigned to this shop"
                detail={
                  setup.voiceNumber
                    ? setup.voiceNumber
                    : "None yet — ask us to assign one before contacting the provider"
                }
              />
              <Check2
                ok={setup.callerIdOnly}
                label={<>&ldquo;Show callers without answering&rdquo;</>}
                detail={
                  setup.callerIdOnly
                    ? "On — the number rings and never picks up"
                    : "Off — switch it on in this shop's settings, or the number may answer"
                }
              />
            </div>

            <div className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-[11px] text-amber-900">
              <strong className="flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" />
                Check these two with the provider before promising the shop anything
              </strong>
              <ol className="mt-1.5 list-decimal space-y-1 pl-4">
                <li>
                  <strong>Can they ring a second, outside number at the same time?</strong> This
                  is a VoIP / cloud-PBX feature. A plain BT landline cannot: its divert only
                  fires <em>after</em> the line has rung out, which is long after staff have
                  picked up — far too late to be any use.
                </li>
                <li>
                  <strong>Does the CALLER&apos;s number reach us, or the shop&apos;s own?</strong>{" "}
                  Many systems replace the caller&apos;s number with the shop&apos;s when they
                  forward a call on. Then every till shows the same number and the popup is
                  worthless. Ring the shop from a mobile and look at the log below — we flag it
                  when the number that arrives is the shop&apos;s own.
                </li>
              </ol>
              <p className="mt-1.5">
                Both must be a yes with <strong>one real shop per provider</strong> before this
                is offered to the rest. It is a provider-by-provider answer, not a
                shop-by-shop one.
              </p>
            </div>

            <Labelled label="Send this to the provider">
              <CopyBlock value={ringMessage} />
            </Labelled>
          </>
        ) : null}
      </Panel>

      {/* ── Did it arrive? ─────────────────────────────────────────────── */}
      <Panel
        title="Test it"
        subtitle="Whichever route you're on, this is how you find out it worked — without standing at a till."
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => testRing.mutate()}
            disabled={testRing.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            <Phone className="h-3.5 w-3.5" />
            {testRing.isPending ? "Ringing…" : "Send a test ring to this shop's tills"}
          </button>
          <button
            type="button"
            onClick={() => setupQuery.refetch()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
          {testRing.isSuccess && (
            <span className="text-[11px] text-emerald-700">
              Sent. A card for {TEST_NUMBER} should be on every till in this shop now — if it
              is, the tills are fine and anything still missing is the provider&apos;s end.
            </span>
          )}
          {testRing.isError && (
            <span className="text-[11px] text-red-600">
              Couldn&apos;t send it — check a shop is selected and you&apos;re still signed in.
            </span>
          )}
        </div>

        <p className="text-[11px] text-zinc-500">
          Then ask the provider to ring the shop, and watch this list. It updates on its own.
          Nothing here after a real call means the ring never reached us: with Route A, the
          provider hasn&apos;t saved the address; with Route B, they can&apos;t ring a second
          number at all.
        </p>

        <RingLog rings={setup?.recentRings ?? []} />
      </Panel>
    </div>
  );
}

/** A number nobody will ever have ordered from, so the test card can't be
 *  mistaken for a real regular ringing. */
const TEST_NUMBER = "+441632960123";

function RingLog({ rings }: { rings: CallerIdRing[] }) {
  if (rings.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-zinc-200 px-3 py-6 text-center text-xs text-zinc-400">
        No rings yet. Send a test ring above, or ask the provider to call the shop.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
      {rings.map((r, i) => (
        <li key={`${r.at}-${i}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="shrink-0 font-mono text-[10px] text-zinc-400">
            {new Date(r.at).toLocaleTimeString()}
          </span>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-zinc-600">
            {SOURCE_LABEL[r.source] ?? r.source}
          </span>
          <span className="font-mono text-[11px] text-zinc-800">{r.masked}</span>
          {r.rejected ? (
            <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
              refused — {r.rejected}
            </span>
          ) : r.looksLikeShopsOwnNumber ? (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
              this is the SHOP&apos;s own number, not the caller&apos;s
            </span>
          ) : (
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
              {r.matched ? "known customer" : "arrived"}
            </span>
          )}
          {r.digits >= 15 && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
              {r.digits} digits — two numbers stuck together
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  webhook: "webhook",
  voice: "our number",
  comet: "comet box",
  test: "test",
};

// ── Small pieces ─────────────────────────────────────────────────────────

function Panel({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white">
      <header className="border-b border-zinc-100 px-3 py-2">
        <h2 className="flex items-center gap-2 text-xs font-semibold text-zinc-900">
          {icon}
          {title}
        </h2>
        {subtitle && <p className="mt-0.5 text-[11px] text-zinc-500">{subtitle}</p>}
      </header>
      <div className="flex flex-col gap-3 p-3">{children}</div>
    </section>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {label}
      </p>
      {children}
    </div>
  );
}

function CopyRow({ value, display }: { value: string; display?: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5 font-mono text-[11px] text-zinc-800">
        {display ?? value}
      </code>
      <CopyButton value={value} />
    </div>
  );
}

function CopyBlock({ value }: { value: string }) {
  return (
    <div className="space-y-1.5">
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50 p-2.5 font-mono text-[11px] leading-relaxed text-zinc-700">
        {value}
      </pre>
      <CopyButton value={value} label="Copy the whole message" />
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await copyText(value);
        if (!ok) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700"
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-emerald-600" /> Copied
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" /> {label ?? "Copy"}
        </>
      )}
    </button>
  );
}

/**
 * Copy, on a tablet too.
 *
 * navigator.clipboard is undefined on any page not served over HTTPS, which
 * includes the tablets on a shop's own network — the exact devices this page
 * is opened on. Falling back to the old execCommand path means the button
 * isn't dead there.
 */
async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const el = document.createElement("textarea");
    el.value = value;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

function Check2({
  ok,
  label,
  detail,
}: {
  ok: boolean;
  label: React.ReactNode;
  detail: string;
}) {
  return (
    <div
      className={`rounded-lg border p-2.5 ${
        ok ? "border-emerald-200 bg-emerald-50" : "border-zinc-200 bg-white"
      }`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {label}
      </p>
      <p className={`mt-0.5 text-xs ${ok ? "text-emerald-800" : "text-zinc-600"}`}>{detail}</p>
    </div>
  );
}
