"use client";

// Phase CA-0 — Careem connection status.
//
// Exists because "I set four environment variables and redeployed" tells you
// nothing about whether Careem accepts them, and the alternative was pasting a
// fetch into the browser console — which fails silently in at least four ways
// (wrong origin, DevTools throttled offline, a console log-level filter, and an
// expired token that a raw fetch won't refresh). This page goes through the
// dashboard's own API client, so the token refreshes itself and the answer is
// just on screen.
//
// It is also where the raw ORDER_CREATED payloads are read while the order
// transformer is being written — from real shapes rather than the spec's
// examples, which is the step that never happened for JET.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";

interface Diagnostics {
  sandbox?: boolean;
  sandboxWarning?: string;
  environment?: string;
  baseUrl?: string;
  clientIdSet?: boolean;
  clientSecretSet?: boolean;
  webhookKeySet?: boolean;
  webhookUrl?: string;
  tokenUrl?: string;
  retryInSeconds?: number;
  token?:
    | {
        ok?: boolean;
        length?: number;
        error?: string;
        status?: number;
        tokenUrl?: string;
        careemSaid?: string;
        hint?: string;
      }
    | string;
  brands?: unknown;
  branches?: unknown;
  webhooks?: {
    receivedSinceRestart?: number;
    everAuthenticated?: boolean;
    lastAt?: string | null;
    hint?: string;
  };
}

interface WebhookEvent {
  at: string;
  eventType: string | null;
  orderId: string | number | null;
  status: string | null;
  authenticated: boolean;
  payloadPreview: string;
}

interface AuthProbe {
  tokenUrl?: string;
  conclusion?: string;
  results?: Array<{ variant: string; status: number; ok: boolean; body: string }>;
}

interface SandboxStatus {
  enabled?: boolean;
  howToEnable?: string;
  brands?: Array<{ id: string; name: string }>;
  branches?: Array<{ id: string; name: string; state: string; pos_integration: boolean }>;
  catalogs?: string[];
}

export default function CareemPage() {
  const [copied, setCopied] = useState<string | null>(null);
  const [probe, setProbe] = useState<AuthProbe | null>(null);
  const [probing, setProbing] = useState(false);

  // Deliberately NOT polled. This call reaches out to Careem, and polling it
  // every thirty seconds is what got us rate-limited by Cloudflare — their docs
  // warn an IP block "might require manual intervention" to undo. Refresh is a
  // button now.
  const diag = useQuery<Diagnostics>({
    queryKey: ["careem-diagnostics"],
    queryFn: () =>
      apiClient
        .get("/v1/integrations/careem/diagnostics")
        .then((r) => r.data as Diagnostics),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  const hooks = useQuery<{ events: WebhookEvent[] }>({
    queryKey: ["careem-webhooks"],
    queryFn: () =>
      apiClient
        .get("/v1/integrations/careem/webhooks", { params: { limit: 10 } })
        .then((r) => r.data as { events: WebhookEvent[] }),
    // Safe to poll: this reads our own in-memory buffer, not Careem.
    refetchInterval: 15_000,
  });

  // ── Sandbox (CA-5) ───────────────────────────────────────────────────────
  // Careem's API answering on our own server, so the integration can be driven
  // before they issue a client. Everything here is a button because the
  // alternative is curl with a bearer token, and this page exists precisely
  // because that went wrong four different ways last time.
  const locationId = useSelectedLocationStore((st) => st.selectedLocationId);
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<{ step: string; body: unknown } | null>(
    null,
  );

  const sandbox = useQuery<SandboxStatus>({
    queryKey: ["careem-sandbox"],
    queryFn: () =>
      apiClient
        .get("/v1/integrations/careem/sandbox/status")
        .then((r) => r.data as SandboxStatus),
    refetchOnWindowFocus: false,
  });

  /** Run one step and show whatever came back — including the failures, which
   *  are the interesting ones here. */
  const step = async (
    label: string,
    call: () => Promise<{ data: unknown }>,
  ) => {
    setRunning(label);
    setResult(null);
    try {
      const res = await call();
      setResult({ step: label, body: res.data });
    } catch (err) {
      const e = err as { response?: { status?: number; data?: unknown } };
      setResult({
        step: `${label} — HTTP ${e.response?.status ?? "?"}`,
        body: e.response?.data ?? String(err),
      });
    } finally {
      setRunning(null);
      void sandbox.refetch();
    }
  };

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked — the text is on screen and selectable anyway */
    }
  };

  const sandboxOn = diag.data?.sandbox === true;
  const tokenOk =
    typeof diag.data?.token === "object" && diag.data.token?.ok === true;
  const tokenObj =
    typeof diag.data?.token === "object" ? diag.data.token : undefined;
  const tokenErr =
    tokenObj?.error ??
    (typeof diag.data?.token === "string" ? diag.data.token : undefined);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Careem</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Connection status and the notifications Careem has sent us.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void diag.refetch();
            void hooks.refetch();
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${diag.isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </header>

      {diag.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking…
        </div>
      ) : diag.isError ? (
        <Panel tone="bad" title="Couldn't reach the API">
          <p className="text-sm">
            {(diag.error as { message?: string })?.message ?? "Unknown error"}
          </p>
        </Panel>
      ) : (
        <>
          {/* ── Credentials ─────────────────────────────────── */}
          <Panel
            tone={sandboxOn ? "warn" : tokenOk ? "good" : "bad"}
            title={
              sandboxOn
                ? "Sandbox — this is us, not Careem"
                : tokenOk
                  ? "Credentials accepted"
                  : "Credentials not working"
            }
          >
            {sandboxOn ? (
              // A token came back, but WE issued it. Saying "credentials
              // accepted" here would be the single most misleading thing this
              // page could do — it is the one question it exists to answer.
              <p className="text-sm">
                {diag.data?.sandboxWarning ??
                  "The sandbox is on: the token and gateway below are this " +
                    "server answering as Careem."}
              </p>
            ) : tokenOk ? (
              <p className="text-sm">
                Careem issued an access token. The{" "}
                <strong>{diag.data?.environment}</strong> gateway is answering.
              </p>
            ) : (
              <div className="space-y-2 text-sm">
                <p>
                  {tokenErr ??
                    `Careem rejected the token request${
                      tokenObj?.status ? ` (HTTP ${tokenObj.status})` : ""
                    }.`}
                </p>
                {tokenObj?.hint && (
                  <p className="rounded border border-red-200 bg-white/60 p-2 text-[13px] leading-relaxed">
                    {tokenObj.hint}
                  </p>
                )}
                {!!diag.data?.retryInSeconds && (
                  <p className="rounded border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900">
                    Not re-checking for another {diag.data.retryInSeconds}s. A
                    credential rejected a moment ago will be rejected again, and
                    repeated token requests are what trigger Careem&apos;s rate
                    limiting.
                  </p>
                )}
                <div>
                  <button
                    type="button"
                    disabled={probing}
                    onClick={async () => {
                      setProbing(true);
                      try {
                        const r = await apiClient.get(
                          "/v1/integrations/careem/auth-probe",
                        );
                        setProbe(r.data as AuthProbe);
                      } catch (e) {
                        setProbe({
                          conclusion: (e as { message?: string })?.message ?? "Probe failed",
                        });
                      } finally {
                        setProbing(false);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    {probing && <Loader2 className="h-3 w-3 animate-spin" />}
                    Run auth probe
                  </button>
                  <p className="mt-1 text-[11px] text-zinc-600">
                    Tries every style once and reports what Careem said to each.
                    Six requests — press it when something has changed, not
                    repeatedly.
                  </p>
                </div>
                {probe && (
                  <div className="rounded border border-red-200 bg-white/60 p-2">
                    <p className="text-[13px] leading-relaxed">{probe.conclusion}</p>
                    {probe.results?.length ? (
                      <table className="mt-2 w-full text-[10px]">
                        <tbody>
                          {probe.results.map((r) => (
                            <tr key={r.variant} className="border-b border-zinc-100 last:border-0">
                              <td className="py-1 pr-2 font-mono">{r.variant}</td>
                              <td className="py-1 pr-2 font-mono">{r.status}</td>
                              <td className="py-1 font-mono text-zinc-600">
                                {r.body.slice(0, 90)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : null}
                  </div>
                )}
                {tokenObj?.careemSaid && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-red-700">
                      Careem said
                    </p>
                    <pre className="mt-1 max-h-40 overflow-auto rounded bg-white/70 p-2 font-mono text-[10px] leading-relaxed text-zinc-800">
                      {pretty(tokenObj.careemSaid)}
                    </pre>
                  </div>
                )}
              </div>
            )}
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
              <Row label="Environment" value={diag.data?.environment} />
              <Row label="Gateway" value={diag.data?.baseUrl} mono />
              <Row label="Token URL" value={diag.data?.tokenUrl} mono />
              <Row
                label="CAREEM_CLIENT_ID"
                value={diag.data?.clientIdSet ? "set" : "missing"}
                bad={!diag.data?.clientIdSet}
              />
              <Row
                label="CAREEM_CLIENT_SECRET"
                value={diag.data?.clientSecretSet ? "set" : "missing"}
                bad={!diag.data?.clientSecretSet}
              />
            </dl>
          </Panel>

          {/* ── Webhook wiring ──────────────────────────────── */}
          <Panel
            tone={
              diag.data?.webhooks?.everAuthenticated
                ? "good"
                : diag.data?.webhooks?.receivedSinceRestart
                  ? "bad"
                  : "warn"
            }
            title="Webhooks"
          >
            <p className="text-sm">{diag.data?.webhooks?.hint}</p>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
              <Row
                label="CAREEM_WEBHOOK_API_KEY"
                value={diag.data?.webhookKeySet ? "set" : "missing"}
                bad={!diag.data?.webhookKeySet}
              />
              <Row
                label="Received since restart"
                value={String(diag.data?.webhooks?.receivedSinceRestart ?? 0)}
              />
            </dl>
            {diag.data?.webhookUrl && (
              <div className="mt-3 flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded bg-zinc-100 px-2 py-1.5 font-mono text-[11px] text-zinc-700">
                  {diag.data.webhookUrl}
                </code>
                <button
                  type="button"
                  onClick={() => copy("url", diag.data!.webhookUrl!)}
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1.5 text-[11px] hover:bg-zinc-50"
                >
                  <Copy className="h-3 w-3" />
                  {copied === "url" ? "Copied" : "Copy"}
                </button>
              </div>
            )}
            <p className="mt-2 text-[11px] text-zinc-500">
              This is the URL to save in Careem&apos;s partner portal, with the
              same key you set in <code>CAREEM_WEBHOOK_API_KEY</code>.
            </p>
          </Panel>

          {/* ── What the credentials can see ────────────────── */}
          {tokenOk && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Json
                title={sandboxOn ? "Brands (sandbox)" : "Brands"}
                value={diag.data?.brands}
              />
              <Json
                title={sandboxOn ? "Branches (sandbox)" : "Branches"}
                value={diag.data?.branches}
              />
            </div>
          )}
        </>
      )}

      {/* ── Recent notifications ──────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-zinc-900">
          Recent notifications
        </h2>
        <p className="text-xs text-zinc-500">
          In memory and per-instance — lost when the API restarts. Here to read
          real payload shapes while the integration is being built.
        </p>
        {hooks.data?.events?.length ? (
          <ul className="space-y-2">
            {hooks.data.events.map((e, i) => (
              <li
                key={`${e.at}-${i}`}
                className="rounded-lg border border-zinc-200 bg-white p-3"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono font-semibold text-zinc-900">
                    {e.eventType ?? "unknown"}
                  </span>
                  {e.orderId != null && (
                    <span className="text-zinc-500">order {String(e.orderId)}</span>
                  )}
                  {e.status && <span className="text-zinc-500">· {e.status}</span>}
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                      e.authenticated
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-red-100 text-red-700"
                    }`}
                  >
                    {e.authenticated ? "key ok" : "key rejected"}
                  </span>
                  <span className="flex-1" />
                  <span className="text-zinc-400">
                    {new Date(e.at).toLocaleTimeString("en-GB")}
                  </span>
                  <button
                    type="button"
                    onClick={() => copy(String(i), e.payloadPreview)}
                    className="inline-flex items-center gap-1 rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] hover:bg-zinc-50"
                  >
                    <Copy className="h-2.5 w-2.5" />
                    {copied === String(i) ? "Copied" : "Copy payload"}
                  </button>
                </div>
                <pre className="mt-2 max-h-56 overflow-auto rounded bg-zinc-50 p-2 font-mono text-[10px] leading-relaxed text-zinc-700">
                  {pretty(e.payloadPreview)}
                </pre>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed border-zinc-200 p-6 text-center text-sm text-zinc-500">
            Nothing received yet. Place a test order in Careem&apos;s sandbox and
            it will appear here.
          </p>
        )}
      </section>

      {/* ── Run the integration ───────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">
            Set up this shop
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Registering a brand and branch, and publishing a menu, are real
            calls to Careem — they run whether or not the sandbox is on. The
            steps marked <span className="font-medium">Sandbox</span> are
            answered by our own server and only appear when it is enabled.
          </p>
          {sandboxOn && (
            <p className="mt-1 text-xs text-amber-700">
              The sandbox is ON, so Careem is not seeing any of this. It is held
              in memory, so any API restart or deploy empties it — if a step
              says a branch does not exist, run &ldquo;Onboard the shop&rdquo;
              again.
            </p>
          )}
        </div>

        {!locationId ? (
          <p className="rounded-lg border border-dashed border-zinc-200 p-4 text-xs text-zinc-600">
            Pick a location in the switcher first — every step below runs
            against it.
          </p>
        ) : (
          <>
            <ol className="space-y-2">
              {[
                {
                  sandboxOnly: true,
                  label: "Check the menu",
                  hint: "Sends nothing. Read a price and check the unit is right.",
                  run: () =>
                    apiClient.get(
                      `/v1/integrations/careem/sandbox/locations/${locationId}/menu/dry-run`,
                    ),
                },
                {
                  sandboxOnly: false,
                  label: "Onboard the shop",
                  hint: "Brand, branch, POS integration, opening hours.",
                  run: () =>
                    apiClient.post(
                      `/v1/integrations/careem/locations/${locationId}/onboard`,
                    ),
                },
                {
                  sandboxOnly: false,
                  label: "Publish the menu — expect this to FAIL",
                  hint: 'A new branch is unmapped. "branch_id is not mapped" is the right answer here.',
                  run: () =>
                    apiClient.post(
                      `/v1/integrations/careem/locations/${locationId}/menu/publish`,
                    ),
                },
                {
                  sandboxOnly: true,
                  label: "Map the branch",
                  hint: "What Careem's operations team does by hand.",
                  run: () =>
                    apiClient.post(
                      `/v1/integrations/careem/sandbox/locations/${locationId}/map`,
                    ),
                },
                {
                  sandboxOnly: false,
                  label: "Publish the menu again",
                  hint: "Same call as step 3. It should work now.",
                  run: () =>
                    apiClient.post(
                      `/v1/integrations/careem/locations/${locationId}/menu/publish`,
                    ),
                },
                {
                  sandboxOnly: true,
                  label: "Send a Careem order",
                  hint: "Built from this shop's real menu. It should land on the orders board.",
                  run: () =>
                    apiClient.post(
                      `/v1/integrations/careem/sandbox/locations/${locationId}/simulate-order`,
                      { itemCount: 2 },
                    ),
                },
                {
                  sandboxOnly: true,
                  label: "Send a self-delivery order",
                  hint: "Careem send customer details ONLY for self-delivery — this one should carry an address, step 6 should not.",
                  run: () =>
                    apiClient.post(
                      `/v1/integrations/careem/sandbox/locations/${locationId}/simulate-order`,
                      { itemCount: 2, selfDelivery: true },
                    ),
                },
                {
                  sandboxOnly: true,
                  label: "Take an item off (86)",
                  hint: "Snooze reaches Careem as PATCH /catalogs/{id}/items — not a menu republish.",
                  run: () =>
                    apiClient.post(
                      `/v1/integrations/careem/sandbox/locations/${locationId}/eighty-six`,
                    ),
                },
                {
                  sandboxOnly: true,
                  label: "What did we actually send?",
                  hint: "Every request the mock received, newest first.",
                  run: () =>
                    apiClient.get("/v1/integrations/careem/sandbox/calls", {
                      params: { limit: 25 },
                    }),
                },
              ]
                .filter((s) => sandboxOn || !s.sandboxOnly)
                .map((s, i) => ({ ...s, n: i + 1 }))
                .map((s) => (
                <li
                  key={s.n}
                  className="flex items-start justify-between gap-4 rounded-lg border border-zinc-200 p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-900">
                      <span className="mr-2 text-zinc-400">{s.n}</span>
                      {s.label}
                      {s.sandboxOnly && (
                        <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                          Sandbox
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500">{s.hint}</p>
                  </div>
                  <button
                    type="button"
                    disabled={running !== null}
                    onClick={() => void step(s.label, s.run)}
                    className="shrink-0 rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
                  >
                    {running === s.label ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      "Run"
                    )}
                  </button>
                </li>
              ))}
            </ol>

            <button
              type="button"
              disabled={running !== null}
              onClick={() =>
                void step("Reset", () =>
                  apiClient.post("/v1/integrations/careem/sandbox/reset"),
                )
              }
              className="text-xs text-zinc-500 underline hover:text-zinc-700"
            >
              Empty the sandbox and start again
            </button>

            {result && (
              <div className="rounded-lg border border-zinc-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-zinc-900">
                    {result.step}
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      copy("sandbox", JSON.stringify(result.body, null, 2))
                    }
                    className="inline-flex items-center gap-1 rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] hover:bg-zinc-50"
                  >
                    <Copy className="h-2.5 w-2.5" />
                    {copied === "sandbox" ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className="mt-2 max-h-96 overflow-auto rounded bg-zinc-50 p-2 font-mono text-[10px] leading-relaxed text-zinc-700">
                  {JSON.stringify(result.body, null, 2)}
                </pre>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/** Payloads are stored as a trimmed string, so a long one may not be valid
 *  JSON any more. Show it raw rather than throwing away the evidence. */
function pretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function Row({
  label,
  value,
  mono,
  bad,
}: {
  label: string;
  value?: string;
  mono?: boolean;
  bad?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-zinc-100 py-1 last:border-0">
      <dt className="text-zinc-500">{label}</dt>
      <dd
        className={`${mono ? "font-mono text-[10px]" : ""} ${
          bad ? "font-semibold text-red-600" : "text-zinc-800"
        } truncate`}
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}

function Json({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </h3>
      <pre className="mt-2 max-h-60 overflow-auto rounded bg-zinc-50 p-2 font-mono text-[10px] leading-relaxed text-zinc-700">
        {JSON.stringify(value ?? null, null, 2)}
      </pre>
    </div>
  );
}

function Panel({
  tone,
  title,
  children,
}: {
  tone: "good" | "bad" | "warn";
  title: string;
  children: React.ReactNode;
}) {
  const Icon =
    tone === "good" ? CheckCircle2 : tone === "bad" ? XCircle : AlertTriangle;
  const ring =
    tone === "good"
      ? "border-emerald-200 bg-emerald-50"
      : tone === "bad"
        ? "border-red-200 bg-red-50"
        : "border-amber-200 bg-amber-50";
  const fg =
    tone === "good"
      ? "text-emerald-700"
      : tone === "bad"
        ? "text-red-700"
        : "text-amber-700";
  return (
    <section className={`rounded-lg border p-4 ${ring}`}>
      <div className={`flex items-center gap-2 ${fg}`}>
        <Icon className="h-4 w-4" />
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <div className="mt-2 text-zinc-800">{children}</div>
    </section>
  );
}
