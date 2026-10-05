"use client";

// Phase TB — Talabat (Delivery Hero POS Middleware).
//
// One page for the whole integration: is the credential working, which of
// this location's brands are which Talabat vendors, what the menu will look
// like on Talabat (and what it refuses to send), open/closed, the orders
// Talabat took that never reached us, and who paid for each promotion.
//
// With TALABAT_SANDBOX on, a row of "be Talabat" buttons drives the whole
// order lifecycle against our real plugin endpoints before Talabat issue
// credentials.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { brandsClient } from "@/lib/api/locations.client";
import {
  talabatClient,
  type TalabatConnection,
  type TalabatPluginCall,
  type TalabatPreview,
} from "@/lib/api/talabat.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";

const money = (n: number | null | undefined) => (Number(n ?? 0)).toFixed(2);
const errText = (e: any) => e?.response?.data?.message ?? e?.message ?? String(e);

export default function TalabatPage() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const [copied, setCopied] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<{ step: string; body: unknown; error?: boolean } | null>(null);
  const [preview, setPreview] = useState<{ connectionId: string; data: TalabatPreview } | null>(null);
  const [lastToken, setLastToken] = useState<string | null>(null);

  // Not polled: it logs in to Talabat. Refresh is a button.
  const diag = useQuery({
    queryKey: ["talabat-diagnostics"],
    queryFn: talabatClient.diagnostics,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  // Safe to poll — our own in-memory buffer.
  const calls = useQuery({
    queryKey: ["talabat-plugin-calls"],
    queryFn: () => talabatClient.pluginCalls(15),
    refetchInterval: 15_000,
  });
  const conns = useQuery({
    queryKey: ["talabat-connections", locationId],
    queryFn: () => talabatClient.connections(locationId ? { locationId } : {}),
    enabled: !!locationId,
  });
  const brands = useQuery({
    queryKey: ["brands", "at-location", locationId],
    queryFn: () => brandsClient.list(locationId ?? undefined),
    enabled: !!locationId,
  });
  const sandboxOn = diag.data?.sandbox === true;
  const sandbox = useQuery({
    queryKey: ["talabat-sandbox"],
    queryFn: talabatClient.sandbox.status,
    enabled: sandboxOn,
    refetchInterval: sandboxOn ? 10_000 : false,
  });

  const step = async (label: string, call: () => Promise<unknown>) => {
    setRunning(label);
    setResult(null);
    try {
      const body = await call();
      setResult({ step: label, body });
      return body;
    } catch (e: any) {
      setResult({ step: `${label} — HTTP ${e?.response?.status ?? "?"}`, body: e?.response?.data ?? errText(e), error: true });
      return null;
    } finally {
      setRunning(null);
      void conns.refetch();
      void calls.refetch();
      if (sandboxOn) void sandbox.refetch();
    }
  };

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* the text is on screen and selectable */
    }
  };

  const login = diag.data?.login;
  const loginOk = typeof login === "object" && (login as any).ok === true;
  const brandName = useMemo(() => {
    const m = new Map((brands.data ?? []).map((b: any) => [b.id, b.name]));
    return (id: string) => m.get(id) ?? id;
  }, [brands.data]);
  const connectedBrandIds = new Set((conns.data ?? []).filter((c) => c.status !== "not_connected").map((c) => c.brandId));

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Talabat</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Direct integration through Delivery Hero&apos;s POS middleware: orders, menu, availability and promotions.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void diag.refetch();
            void calls.refetch();
            void conns.refetch();
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${diag.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </header>

      {/* ── Credential status ── */}
      {diag.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking Talabat…
        </div>
      ) : diag.isError ? (
        <Panel tone="bad" title="Could not load Talabat status">
          <p className="text-sm">{errText(diag.error)}</p>
        </Panel>
      ) : diag.data ? (
        <>
          {diag.data.sandboxWarning && (
            <Panel tone="warn" title="Sandbox is on">
              <p className="text-sm">{diag.data.sandboxWarning}</p>
            </Panel>
          )}
          <Panel
            tone={loginOk ? "good" : diag.data.configured ? "bad" : "warn"}
            title={
              loginOk
                ? `Logged in to Talabat (${diag.data.environment})`
                : diag.data.configured
                  ? "Talabat refused the login"
                  : "Not configured yet"
            }
          >
            <dl className="grid grid-cols-1 gap-x-6 text-xs sm:grid-cols-2">
              <Row label="Environment" value={diag.data.environment} />
              <Row label="Middleware" value={diag.data.baseUrl ?? "— (production needs TALABAT_API_BASE)"} mono />
              <Row label="Username" value={diag.data.usernameSet ? "set" : "missing"} bad={!diag.data.usernameSet && !sandboxOn} />
              <Row label="Password" value={diag.data.passwordSet ? "set" : "missing"} bad={!diag.data.passwordSet && !sandboxOn} />
              <Row label="Plugin JWT secret" value={diag.data.pluginSecretSet ? "set" : sandboxOn ? "sandbox secret" : "missing"} bad={!diag.data.pluginSecretSet && !sandboxOn} />
              <Row label="Signed call received" value={diag.data.middlewareEverVerified ? "yes" : "not yet"} />
            </dl>
            {typeof login === "string" && <p className="mt-2 text-xs text-zinc-600">{login}</p>}
            {typeof login === "object" && !loginOk && (
              <pre className="mt-2 max-h-40 overflow-auto rounded bg-white/70 p-2 font-mono text-[10px]">
                {JSON.stringify(login, null, 2)}
              </pre>
            )}
            {diag.data.retryInSeconds > 0 && (
              <div className="mt-2 flex items-center gap-2 text-xs text-zinc-600">
                Not asking again for {diag.data.retryInSeconds}s.
                <button
                  className="rounded border border-zinc-300 px-2 py-0.5 hover:bg-white"
                  onClick={() => step("Retry login", async () => (await talabatClient.retry(), diag.refetch()))}
                >
                  Retry now
                </button>
              </div>
            )}
            <div className="mt-3 flex items-center gap-2 text-xs">
              <span className="text-zinc-500">Plugin base URL for Talabat:</span>
              <code className="truncate rounded bg-white/70 px-1.5 py-0.5 font-mono text-[11px]">{diag.data.pluginBaseUrl}</code>
              <button onClick={() => copy("base", diag.data!.pluginBaseUrl)} className="text-zinc-500 hover:text-zinc-800">
                <Copy className="h-3.5 w-3.5" />
              </button>
              {copied === "base" && <span className="text-emerald-600">copied</span>}
            </div>
          </Panel>
        </>
      ) : null}

      {/* ── Vendors at this location ── */}
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-zinc-900">Talabat vendors at this location</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Each brand you sell on Talabat here is one Talabat vendor. The remote ID is yours — give it to Talabat with the
          chain code and vendor code they assigned.
        </p>
        {!locationId ? (
          <p className="mt-3 text-sm text-zinc-500">Pick a location first.</p>
        ) : conns.isLoading ? (
          <Loader2 className="mt-3 h-4 w-4 animate-spin text-zinc-400" />
        ) : (
          <div className="mt-3 space-y-3">
            {(conns.data ?? []).map((c) => (
              <ConnectionCard
                key={c.id}
                c={c}
                brandName={brandName(c.brandId)}
                running={running}
                step={step}
                onPreview={(data) => setPreview({ connectionId: c.id, data })}
                sandboxOn={sandboxOn}
                onSandboxOrder={(token) => setLastToken(token)}
              />
            ))}
            <ConnectForm
              brands={(brands.data ?? []).filter((b: any) => !connectedBrandIds.has(b.id))}
              locationId={locationId}
              running={running}
              step={step}
            />
          </div>
        )}
      </section>

      {/* ── Catalog preview ── */}
      {preview && (
        <section className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900">
              Catalog preview — “{preview.data.menu.name}”{" "}
              <span className={preview.data.wouldPublish ? "text-emerald-600" : "text-red-600"}>
                {preview.data.wouldPublish ? "ready to publish" : "would be refused"}
              </span>
            </h2>
            <button className="text-xs text-zinc-500 hover:text-zinc-800" onClick={() => setPreview(null)}>
              close
            </button>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {preview.data.stats.products} products · {preview.data.stats.categories} categories · {preview.data.stats.toppings} choice
            groups · {preview.data.stats.options} choices · {preview.data.stats.images} photos
          </p>
          {preview.data.problems.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs">
              {preview.data.problems.map((p, i) => (
                <li key={i} className={p.level === "error" ? "text-red-700" : "text-amber-700"}>
                  {p.level === "error" ? "✕" : "!"} {p.message}
                </li>
              ))}
            </ul>
          )}
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-zinc-500">Raw catalog JSON</summary>
            <pre className="mt-2 max-h-96 overflow-auto rounded bg-zinc-50 p-2 font-mono text-[10px]">
              {JSON.stringify(preview.data.catalog, null, 2)}
            </pre>
          </details>
        </section>
      )}

      <PromotionsReport locationId={locationId} />

      {/* ── Sandbox ── */}
      {sandboxOn && (
        <section className="rounded-lg border border-amber-200 bg-amber-50/40 p-4">
          <h2 className="text-sm font-semibold text-zinc-900">Sandbox — be Talabat</h2>
          <p className="mt-1 text-xs text-zinc-600">
            These calls hit our real plugin endpoints with a signed middleware JWT. Use the vendor buttons above to place
            orders; these act on the most recent sandbox order.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {[
              ["ORDER_CANCELLED", "Talabat cancels it"],
              ["COURIER_ARRIVED_AT_VENDOR", "Rider arrives"],
              ["SHOW_RIDER_WAITING_WARNING", "Rider waiting (AWT)"],
              ["HIDE_RIDER_WAITING_WARNING", "Clear waiting warning"],
              ["RIDER_ACCEPTED", "Rider accepts job"],
              ["ORDER_PICKED_UP", "Rider picks up"],
            ].map(([status, label]) => (
              <Btn
                key={status}
                disabled={!lastToken || !!running}
                onClick={() => step(label!, () => talabatClient.sandbox.notify(lastToken!, status!))}
              >
                {label}
              </Btn>
            ))}
            <Btn disabled={!!running} onClick={() => step("Sandbox reset", talabatClient.sandbox.reset)}>
              Reset sandbox
            </Btn>
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">Latest sandbox order: {lastToken ?? "none yet"}</p>
          {sandbox.data && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-zinc-600">
                Sandbox state — {sandbox.data.orders?.length ?? 0} orders, {sandbox.data.catalogs?.length ?? 0} catalog imports
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded bg-white p-2 font-mono text-[10px]">
                {JSON.stringify(sandbox.data, null, 2)}
              </pre>
            </details>
          )}
        </section>
      )}

      {/* ── Last action ── */}
      {(running || result) && (
        <section className={`rounded-lg border p-3 ${result?.error ? "border-red-200 bg-red-50" : "border-zinc-200 bg-white"}`}>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            {running ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> {running}…
              </span>
            ) : (
              result!.step
            )}
          </h3>
          {result && (
            <pre className="mt-2 max-h-80 overflow-auto rounded bg-zinc-50 p-2 font-mono text-[10px] leading-relaxed text-zinc-700">
              {typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2)}
            </pre>
          )}
        </section>
      )}

      {/* ── What Talabat sent us ── */}
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-zinc-900">Recent calls from Talabat</h2>
        <p className="mt-1 text-xs text-zinc-500">This server only, since its last restart.</p>
        <CallsTable calls={calls.data ?? []} />
      </section>

      <ActivationSheet step={step} />
    </div>
  );
}

function ConnectionCard({
  c,
  brandName,
  running,
  step,
  onPreview,
  sandboxOn,
  onSandboxOrder,
}: {
  c: TalabatConnection;
  brandName: string;
  running: string | null;
  step: (label: string, call: () => Promise<unknown>) => Promise<unknown>;
  onPreview: (p: TalabatPreview) => void;
  sandboxOn: boolean;
  onSandboxOrder: (token: string) => void;
}) {
  const live = c.status !== "not_connected";
  const closed = c.availability && !c.availability.open;
  return (
    <div className="rounded-md border border-zinc-200 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-medium text-zinc-900">
          {brandName}{" "}
          <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${live ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>
            {c.status}
          </span>
          {closed && <span className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-700">closed by Talabat</span>}
        </div>
        <div className="text-[11px] text-zinc-500">
          last order/notification: {c.lastWebhookAt ? new Date(c.lastWebhookAt).toLocaleString() : "never"}
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 text-xs sm:grid-cols-4">
        <Row label="Remote ID" value={c.remoteId ?? "—"} mono />
        <Row label="Chain code" value={c.chainCode ?? "missing"} bad={!c.chainCode} />
        <Row label="Vendor code" value={c.platformVendorId ?? "—"} />
        <Row label="Global entity" value={c.globalEntityId ?? "—"} />
      </dl>
      {c.hubriseWarning && (
        <p className="mt-2 text-xs text-amber-700">
          This location also uses HubRise — turn Talabat off in HubRise, or orders arrive twice.
        </p>
      )}
      {c.catalog && (
        <p className="mt-2 text-xs text-zinc-600">
          Menu: <b>{c.catalog.status}</b> — sent {new Date(c.catalog.sentAt).toLocaleString()}
          {c.catalog.stats ? ` · ${c.catalog.stats.products} products` : ""}
          {c.catalog.message ? ` · ${c.catalog.message}` : ""}
        </p>
      )}
      {live && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Btn
            disabled={!!running}
            onClick={async () => {
              const p = (await step("Catalog preview", () => talabatClient.preview(c.id))) as TalabatPreview | null;
              if (p) onPreview(p);
            }}
          >
            Preview menu
          </Btn>
          <Btn disabled={!!running || !c.chainCode} onClick={() => step("Publish menu", () => talabatClient.publish(c.id))}>
            Publish menu
          </Btn>
          <Btn disabled={!!running || !c.chainCode} onClick={() => step("Menu import log", () => talabatClient.catalogLogs(c.id))}>
            Import log
          </Btn>
          <Btn disabled={!!running || !c.chainCode} onClick={() => step("Availability", () => talabatClient.availability(c.id))}>
            Open/closed?
          </Btn>
          <Btn disabled={!!running || !c.chainCode} onClick={() => step("Close 30 min", () => talabatClient.setAvailability(c.id, { open: false, minutes: 30 }))}>
            Close 30 min
          </Btn>
          <Btn disabled={!!running || !c.chainCode} onClick={() => step("Reopen", () => talabatClient.setAvailability(c.id, { open: true }))}>
            Reopen
          </Btn>
          <Btn disabled={!!running || !c.chainCode} onClick={() => step("Reconcile 24h", () => talabatClient.reconcile(c.id, { hours: 24 }))}>
            Missed orders?
          </Btn>
          <Btn
            disabled={!!running || !c.chainCode}
            onClick={() =>
              confirm("Pull every order Talabat accepted in the last 24h that isn't on the board?") &&
              step("Reconcile + import", () => talabatClient.reconcile(c.id, { hours: 24, importMissing: true }))
            }
          >
            Import missed orders
          </Btn>
          <Btn
            tone="danger"
            disabled={!!running}
            onClick={() =>
              confirm(`Disconnect ${brandName} from Talabat? Orders sent to remote ID ${c.remoteId} will be refused.`) &&
              step("Disconnect", () => talabatClient.disconnect(c.id))
            }
          >
            Disconnect
          </Btn>
        </div>
      )}
      {live && sandboxOn && (
        <div className="mt-2 flex flex-wrap gap-2 border-t border-dashed border-amber-200 pt-2">
          <span className="self-center text-[11px] font-semibold uppercase text-amber-700">Sandbox</span>
          {(
            [
              ["OWN_DELIVERY", "Talabat-rider order"],
              ["VENDOR_DELIVERY", "Own-delivery order"],
              ["PICKUP", "Pickup order"],
            ] as const
          ).map(([kind, label]) => (
            <Btn
              key={kind}
              disabled={!!running}
              onClick={async () => {
                const r = (await step(`Sandbox ${label}`, () => talabatClient.sandbox.simulateOrder(c.id, { kind, withDiscount: kind === "OWN_DELIVERY" }))) as any;
                if (r?.token) onSandboxOrder(r.token);
              }}
            >
              {label}
            </Btn>
          ))}
          <Btn
            disabled={!!running}
            onClick={async () => {
              const r = (await step("Sandbox test order", () => talabatClient.sandbox.simulateOrder(c.id, { kind: "OWN_DELIVERY", test: true }))) as any;
              if (r?.token) onSandboxOrder(r.token);
            }}
          >
            Test order
          </Btn>
          <Btn disabled={!!running} onClick={() => step("Talabat closes vendor", () => talabatClient.sandbox.notifyAvailability(c.id, { closed: true, minutes: 20 }))}>
            Talabat closes vendor
          </Btn>
          <Btn disabled={!!running} onClick={() => step("Talabat reopens vendor", () => talabatClient.sandbox.notifyAvailability(c.id, { closed: false }))}>
            Talabat reopens
          </Btn>
          <Btn disabled={!!running} onClick={() => step("Talabat asks for menu", () => talabatClient.sandbox.requestMenu(c.id))}>
            Talabat asks for menu
          </Btn>
        </div>
      )}
    </div>
  );
}

function ConnectForm({
  brands,
  locationId,
  running,
  step,
}: {
  brands: Array<{ id: string; name: string }>;
  locationId: string;
  running: string | null;
  step: (label: string, call: () => Promise<unknown>) => Promise<unknown>;
}) {
  const [brandId, setBrandId] = useState("");
  const [chainCode, setChainCode] = useState("");
  const [vendorCode, setVendorCode] = useState("");
  const [remoteId, setRemoteId] = useState("");
  const [globalEntityId, setGlobalEntityId] = useState("TB_AE");
  if (!brands.length) return null;
  return (
    <div className="rounded-md border border-dashed border-zinc-300 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Connect a brand</h3>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-5">
        <select value={brandId} onChange={(e) => setBrandId(e.target.value)} className="rounded border border-zinc-300 px-2 py-1.5 text-sm">
          <option value="">Brand…</option>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <input value={chainCode} onChange={(e) => setChainCode(e.target.value)} placeholder="Chain code (from Talabat)" className="rounded border border-zinc-300 px-2 py-1.5 text-sm" />
        <input value={vendorCode} onChange={(e) => setVendorCode(e.target.value)} placeholder="Vendor code (from Talabat)" className="rounded border border-zinc-300 px-2 py-1.5 text-sm" />
        <input value={globalEntityId} onChange={(e) => setGlobalEntityId(e.target.value)} placeholder="Global entity e.g. TB_AE" className="rounded border border-zinc-300 px-2 py-1.5 text-sm" />
        <input value={remoteId} onChange={(e) => setRemoteId(e.target.value)} placeholder="Remote ID (blank = generate)" className="rounded border border-zinc-300 px-2 py-1.5 text-sm" />
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">
        Chain and vendor codes can be added later — orders still route by the remote ID once Talabat attach it.
      </p>
      <Btn
        className="mt-2"
        disabled={!brandId || !!running}
        onClick={() =>
          step("Connect", () =>
            talabatClient.connect({
              brandId,
              locationId,
              chainCode: chainCode || undefined,
              platformVendorId: vendorCode || undefined,
              globalEntityId: globalEntityId || undefined,
              remoteId: remoteId || undefined,
            }),
          )
        }
      >
        Connect to Talabat
      </Btn>
    </div>
  );
}

function PromotionsReport({ locationId }: { locationId: string | null }) {
  const [days, setDays] = useState(7);
  const from = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  const report = useQuery({
    queryKey: ["talabat-promotions", locationId, days],
    queryFn: () => talabatClient.promotions({ from, ...(locationId ? { locationId } : {}) }),
    enabled: !!locationId,
  });
  const r = report.data;
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-900">Talabat promotions — who paid</h2>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded border border-zinc-300 px-2 py-1 text-xs">
          {[1, 7, 30, 90].map((d) => (
            <option key={d} value={d}>
              Last {d} day{d > 1 ? "s" : ""}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Talabat restaurant promotions are created in Talabat&apos;s portal. Every order tells us how each discount was split
        between Talabat, the restaurant and any third party — this adds it up.
      </p>
      {report.isLoading ? (
        <Loader2 className="mt-3 h-4 w-4 animate-spin text-zinc-400" />
      ) : !r ? null : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-5">
            <Stat label="Orders" value={String(r.orders)} />
            <Stat label="With a discount" value={String(r.ordersWithDiscount)} />
            <Stat label="Discounts" value={money(r.discounts.amount)} />
            <Stat label="Funded by you" value={money(r.discounts.vendor)} tone="bad" />
            <Stat label="Funded by Talabat" value={money(r.discounts.platform)} tone="good" />
          </div>
          {r.byPromotion.length > 0 ? (
            <table className="mt-3 w-full text-xs">
              <thead className="text-left text-zinc-500">
                <tr>
                  <th className="py-1">Promotion</th>
                  <th className="py-1 text-right">Orders</th>
                  <th className="py-1 text-right">Discount</th>
                  <th className="py-1 text-right">You</th>
                  <th className="py-1 text-right">Talabat</th>
                  <th className="py-1 text-right">Third party</th>
                  <th className="py-1 text-right">Unattributed</th>
                </tr>
              </thead>
              <tbody>
                {r.byPromotion.map((p) => (
                  <tr key={p.name} className="border-t border-zinc-100">
                    <td className="py-1 font-medium text-zinc-800">{p.name}</td>
                    <td className="py-1 text-right">{p.orders}</td>
                    <td className="py-1 text-right">{money(p.amount)}</td>
                    <td className="py-1 text-right text-red-700">{money(p.vendor)}</td>
                    <td className="py-1 text-right text-emerald-700">{money(p.platform)}</td>
                    <td className="py-1 text-right">{money(p.thirdParty)}</td>
                    <td className="py-1 text-right text-zinc-500">{money(p.unattributed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-3 text-xs text-zinc-500">No discounted Talabat orders in this period.</p>
          )}
        </>
      )}
    </section>
  );
}

function ActivationSheet({ step }: { step: (label: string, call: () => Promise<unknown>) => Promise<unknown> }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-zinc-900">Activation details for Talabat</h2>
      <p className="mt-1 text-xs text-zinc-500">
        Talabat ask for the integration name and code, plugin base URL, and each vendor&apos;s remote ID and flow. This fills
        it in from your connections.
      </p>
      <Btn className="mt-2" onClick={() => step("Activation sheet", talabatClient.activationSheet)}>
        Show activation details
      </Btn>
    </section>
  );
}

function CallsTable({ calls }: { calls: TalabatPluginCall[] }) {
  if (!calls.length) return <p className="mt-3 text-xs text-zinc-500">Nothing yet.</p>;
  return (
    <table className="mt-3 w-full text-xs">
      <thead className="text-left text-zinc-500">
        <tr>
          <th className="py-1">When</th>
          <th className="py-1">Endpoint</th>
          <th className="py-1">Remote ID</th>
          <th className="py-1">JWT</th>
          <th className="py-1">HTTP</th>
          <th className="py-1">Outcome</th>
        </tr>
      </thead>
      <tbody>
        {calls.map((c, i) => (
          <tr key={i} className="border-t border-zinc-100 align-top">
            <td className="whitespace-nowrap py-1 text-zinc-500">{new Date(c.at).toLocaleTimeString()}</td>
            <td className="py-1 font-mono">{c.endpoint}</td>
            <td className="py-1 font-mono">{c.remoteId ?? "—"}</td>
            <td className={`py-1 ${c.jwt === "ok" ? "text-emerald-700" : "text-red-700"}`}>{c.jwt}</td>
            <td className="py-1">{c.httpStatus}</td>
            <td className="py-1 text-zinc-700">{c.outcome}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Btn({
  children,
  onClick,
  disabled,
  tone,
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => unknown;
  disabled?: boolean;
  tone?: "danger";
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => void onClick?.()}
      disabled={disabled}
      className={`rounded-md border px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
        tone === "danger" ? "border-red-200 text-red-700 hover:bg-red-50" : "border-zinc-300 text-zinc-700 hover:bg-zinc-50"
      } ${className}`}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-md border border-zinc-200 p-2">
      <div className={`text-base font-semibold ${tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-red-700" : "text-zinc-900"}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
    </div>
  );
}

function Row({ label, value, mono, bad }: { label: string; value?: string; mono?: boolean; bad?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-zinc-100 py-1 last:border-0">
      <dt className="text-zinc-500">{label}</dt>
      <dd className={`${mono ? "font-mono text-[10px]" : ""} ${bad ? "font-semibold text-red-600" : "text-zinc-800"} truncate`}>{value ?? "—"}</dd>
    </div>
  );
}

function Panel({ tone, title, children }: { tone: "good" | "bad" | "warn"; title: string; children: React.ReactNode }) {
  const Icon = tone === "good" ? CheckCircle2 : tone === "bad" ? XCircle : AlertTriangle;
  const ring =
    tone === "good" ? "border-emerald-200 bg-emerald-50" : tone === "bad" ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50";
  const fg = tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-red-700" : "text-amber-700";
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
