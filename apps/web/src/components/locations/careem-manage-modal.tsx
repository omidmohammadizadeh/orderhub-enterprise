"use client";

// Careem channel management modal — same organised surface as the Keeta, Glovo,
// Just Eat, Uber Eats and Deliveroo ones.
//
// WHERE CAREEM DIFFERS
//
// 1. Going live is a sequence with a human step in the middle: register, Careem
//    operations map the branch, publish the menu, turn orders on. The Status tab
//    shows it as that sequence, because "pending" alone doesn't say whose move
//    it is.
// 2. Turning orders on is its own switch. A shop already trading on Careem keeps
//    using its Careem tablet until someone presses it, and pressing it again
//    sends orders straight back there.
// 3. Careem only take whole currency units, so a menu with AED 18.50 is refused
//    before it is sent, with the items named.

import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Check,
  Clock,
  Copy,
  Loader2,
  Pause,
  Play,
  Settings2,
  Trash2,
  Upload,
  UtensilsCrossed,
  X,
} from "lucide-react";
import toast from "react-hot-toast";
import { careemClient, type CareemMenuProblem } from "@/lib/api/careem.client";
import { PlatformLogo } from "@/components/ui/platform-logo";
import { ChannelVariantMenuPanel } from "@/components/locations/channel-variant-menu-panel";

const CATALOG_TEXT: Record<string, string> = {
  PROCESSING: "Careem is processing it",
  COMPLETED: "Live on Careem",
  FAILED: "Rejected by Careem",
  SEND_FAILED: "Upload failed before Careem accepted it",
};

export function CareemManageModal({
  connectionId,
  brandId,
  locationId,
  open,
  onClose,
  onChanged,
}: {
  connectionId: string;
  brandId: string;
  locationId: string;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"status" | "menu">("status");
  const [problems, setProblems] = useState<CareemMenuProblem[]>([]);

  const health = useQuery({
    queryKey: ["careem-health", connectionId],
    queryFn: () => careemClient.health(connectionId),
    enabled: open,
    // A catalog settles on Careem's webhook, usually within seconds.
    refetchInterval: (q) => (q.state.data?.catalog?.status === "PROCESSING" ? 10_000 : false),
  });

  const err = (e: any) =>
    toast.error(
      e?.response?.data?.message ?? e?.response?.data?.careemSaid ?? e?.message ?? "Careem request failed",
      { duration: 8000 },
    );
  const settled = () => {
    health.refetch();
    onChanged();
  };

  const register = useMutation({
    mutationFn: () => careemClient.connect({ brandId, locationId }),
    onSuccess: () => {
      toast.success("Registered with Careem");
      settled();
    },
    onError: err,
  });
  const orders = useMutation({
    mutationFn: (active: boolean) => careemClient.setOrders(connectionId, active),
    onSuccess: (_, active) => {
      toast.success(active ? "Careem orders now come to OrderHub" : "Careem orders go back to the Careem tablet");
      settled();
    },
    onError: err,
  });
  const pause = useMutation({
    mutationFn: () => careemClient.pause(connectionId, 30),
    onSuccess: () => {
      toast.success("Paused for 30 minutes. Careem reopen it automatically.");
      settled();
    },
    onError: err,
  });
  const resume = useMutation({
    mutationFn: () => careemClient.resume(connectionId),
    onSuccess: () => {
      toast.success("Open on Careem");
      settled();
    },
    onError: err,
  });
  const hours = useMutation({
    mutationFn: () => careemClient.publishHours(connectionId),
    onSuccess: () => toast.success("Opening hours sent to Careem"),
    onError: err,
  });
  const publish = useMutation({
    mutationFn: () => careemClient.publishAssignedMenu(connectionId),
    onSuccess: (r) => {
      if (r.ok) {
        setProblems([]);
        toast.success("Menu sent to Careem. About 5 minutes to appear in the app.");
      } else {
        setProblems(r.errors);
        toast.error("Menu not sent. Fix the items listed first.");
      }
      settled();
    },
    onError: err,
  });
  const disconnect = useMutation({
    mutationFn: () => careemClient.disconnect(connectionId),
    onSuccess: () => {
      toast.success("Careem disconnected. Orders go to the Careem tablet.");
      onChanged();
      onClose();
    },
    onError: err,
  });

  if (!open) return null;

  const h = health.data;
  const catalog = h?.catalog ?? null;
  const catalogLive = catalog?.status === "COMPLETED" || !!h?.catalogOnBranch;
  const paused = h?.visibility?.status === "inactive";
  const offline = h?.visibility?.status === "offline";

  const publishButton = (
    <button
      onClick={() => publish.mutate()}
      disabled={publish.isPending || !h?.mapped}
      title={h?.mapped ? undefined : "Careem must map the branch first"}
      className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
    >
      {publish.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
      Publish menu
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="careem-manage-title"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-zinc-50 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-5 py-4">
          <PlatformLogo platform="CAREEM" size={40} />
          <div className="min-w-0 flex-1">
            <h2 id="careem-manage-title" className="text-base font-semibold text-zinc-900">
              Careem
            </h2>
            <p className="truncate text-xs text-zinc-500">
              {h ? (h.environment === "production" ? "Production" : "Staging") : "Loading…"}
              {h?.posIntegration ? " · Orders come to OrderHub" : " · Orders not on yet"}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex items-center gap-1 border-b border-zinc-200 bg-white px-5 pt-2" role="tablist">
          {[
            { id: "status" as const, label: "Status", icon: Settings2 },
            { id: "menu" as const, label: "Menu", icon: UtensilsCrossed },
          ].map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium ${active ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-800"}`}
              >
                <t.icon className="h-3.5 w-3.5" aria-hidden="true" />
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {health.isLoading ? (
            <div className="flex h-24 items-center justify-center text-zinc-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : tab === "menu" ? (
            <>
              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-zinc-800">Last menu publish</h3>
                  {publishButton}
                </div>
                {catalog ? (
                  <p className="text-[11px] text-zinc-600">
                    <span
                      className={
                        catalog.status === "COMPLETED"
                          ? "font-semibold text-emerald-700"
                          : catalog.status === "PROCESSING"
                            ? "font-semibold text-amber-700"
                            : "font-semibold text-red-700"
                      }
                    >
                      {CATALOG_TEXT[catalog.status ?? ""] ?? catalog.status ?? "—"}
                    </span>
                    {catalog.menuName ? ` · ${catalog.menuName}` : ""}
                    {catalog.sentAt ? ` · sent ${new Date(catalog.sentAt).toLocaleString()}` : ""}
                    {catalog.stats ? ` · ${catalog.stats.items} products` : ""}
                    {catalog.message ? ` · ${catalog.message}` : ""}
                  </p>
                ) : (
                  <p className="text-[11px] text-zinc-500">No menu sent yet.</p>
                )}
                {problems.length > 0 && (
                  <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-red-700">
                    {problems.slice(0, 12).map((p, i) => (
                      <li key={`${p.id}-${i}`}>{p.message}</li>
                    ))}
                    {problems.length > 12 && <li>and {problems.length - 12} more</li>}
                  </ul>
                )}
                <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                  Publishing replaces this outlet&apos;s whole Careem menu. Careem only accept whole-number prices,
                  so a price like 18.50 is refused and named here.
                </p>
              </section>
              <ChannelVariantMenuPanel brandId={brandId} locationId={locationId} channel="CAREEM" />
            </>
          ) : (
            <>
              {h?.wrongEnvironment && (
                <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <p className="text-[11px] text-amber-800">
                    This was registered on Careem&apos;s other environment. Register it on{" "}
                    {h.environment === "production" ? "production" : "staging"}, and Careem operations will need to map
                    it there.
                  </p>
                  <button
                    onClick={() => register.mutate()}
                    disabled={register.isPending}
                    className="mt-2 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {register.isPending ? "Registering…" : "Register again"}
                  </button>
                </section>
              )}
              {h?.lastError && !h.wrongEnvironment && (
                <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-[11px] text-red-700">
                  Careem said: {h.lastError}
                </p>
              )}
              {offline && (
                <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-800">
                  Careem have taken this outlet offline
                  {h?.visibility?.reason ? ` (${h.visibility.reason})` : ""}. Only Careem operations can bring it back.
                </p>
              )}

              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h3 className="mb-3 text-xs font-semibold text-zinc-800">Going live</h3>
                <ol className="space-y-3">
                  <Step done={!!h?.registered && !h?.wrongEnvironment} n={1} title="Registered with Careem" />
                  <Step
                    done={!!h?.mapped}
                    n={2}
                    title={h?.mapped ? "Mapped by Careem" : "Waiting for Careem to map this branch"}
                  >
                    {!h?.mapped && (
                      <p className="text-[11px] text-zinc-500">
                        Send Careem operations this branch ID and the outlet it belongs to. For a shop already on Careem,
                        agree a time, so the menu goes out straight after.
                      </p>
                    )}
                    {h?.branchId && <BranchId id={h.branchId} />}
                  </Step>
                  <Step done={catalogLive} n={3} title={catalogLive ? "Menu live on Careem" : "Publish the menu and hours"}>
                    {!catalogLive && <div className="mt-1">{publishButton}</div>}
                  </Step>
                  <Step
                    done={!!h?.posIntegration}
                    n={4}
                    title={h?.posIntegration ? "Orders come to OrderHub" : "Turn orders on"}
                  >
                    {h?.posIntegration ? (
                      <button
                        onClick={() => orders.mutate(false)}
                        disabled={orders.isPending}
                        className="mt-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
                      >
                        Send orders back to the Careem tablet
                      </button>
                    ) : (
                      <>
                        <p className="text-[11px] text-zinc-500">
                          Before you do: ask Careem to turn off auto-acceptance for this branch, and log the shop out of
                          the Careem portal. Orders accepted there never reach OrderHub.
                        </p>
                        <button
                          onClick={() => orders.mutate(true)}
                          disabled={orders.isPending || !h?.mapped || !catalogLive}
                          className="mt-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {orders.isPending ? "Switching…" : "Turn orders on"}
                        </button>
                      </>
                    )}
                  </Step>
                </ol>
              </section>

              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h3 className="mb-2 text-xs font-semibold text-zinc-800">Store</h3>
                <p className="mb-2 text-[11px] text-zinc-500">
                  {paused
                    ? "Closed to Careem customers right now."
                    : h?.visibility?.status === "active"
                      ? "Open to Careem customers during its opening hours."
                      : "Available once Careem have mapped the branch."}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => resume.mutate()}
                    disabled={resume.isPending || !h?.mapped || offline}
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {resume.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    Open
                  </button>
                  <button
                    onClick={() => pause.mutate()}
                    disabled={pause.isPending || !h?.mapped || offline}
                    className="flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100 disabled:opacity-50"
                  >
                    {pause.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pause className="h-3.5 w-3.5" />}
                    Pause 30 minutes
                  </button>
                  <button
                    onClick={() => hours.mutate()}
                    disabled={hours.isPending || h?.wrongEnvironment || !h?.mapped}
                    title={h?.mapped ? undefined : "Careem must map the branch first"}
                    className="ml-auto flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
                  >
                    {hours.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
                    Push opening hours
                  </button>
                </div>
              </section>

              <section className="rounded-xl border border-red-200 bg-white p-4">
                <h3 className="text-xs font-semibold text-red-700">Disconnect</h3>
                <p className="mt-1 text-[11px] text-zinc-500">
                  Sends orders back to the Careem tablet. The branch stays registered, so reconnecting needs no new
                  mapping.
                </p>
                <button
                  onClick={() => {
                    if (window.confirm("Disconnect Careem here? Orders will go to the Careem tablet.")) {
                      disconnect.mutate();
                    }
                  }}
                  disabled={disconnect.isPending}
                  className="mt-2 flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Disconnect
                </button>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children?: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span
        aria-hidden="true"
        className={`mt-0.5 grid h-5 w-5 flex-shrink-0 place-items-center rounded-full text-[10px] font-semibold ${done ? "bg-emerald-600 text-white" : "bg-zinc-100 text-zinc-500"}`}
      >
        {done ? <Check className="h-3 w-3" /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className={`text-xs font-medium ${done ? "text-zinc-900" : "text-zinc-700"}`}>
          {title}
          <span className="sr-only">{done ? " (done)" : " (to do)"}</span>
        </p>
        {children}
      </div>
    </li>
  );
}

function BranchId({ id }: { id: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-zinc-100 px-2 py-1">
      <code className="min-w-0 flex-1 truncate text-[11px] text-zinc-700">{id}</code>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(id).then(() => toast.success("Branch ID copied"));
        }}
        aria-label="Copy branch ID"
        className="rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800"
      >
        <Copy className="h-3 w-3" />
      </button>
    </div>
  );
}
