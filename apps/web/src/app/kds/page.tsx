"use client";

// Phase KD — franchise-grade kitchen display.
//
// Fullscreen dark station view: SLA-coloured ticket rail, channel/type
// chips, tap-to-strike item lines, bump/recall, all-day production counter,
// speed-of-service header, rider-waiting flash, new-order chime, screen
// wake-lock and an offline banner. One page serves every station — the
// screen id in ?screen= carries its routing + settings.

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  RotateCcw,
  Maximize2,
  X,
  Volume2,
  VolumeX,
  WifiOff,
  Bike,
  CalendarClock,
  AlertTriangle,
  Monitor,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { useAuthStore } from "@/stores/auth.store";
import { socketClient } from "@/lib/socket/socket.client";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

interface KdsScreenSettings {
  stationType?: "STATION" | "EXPO";
  categoryIds?: string[];
  itemIds?: string[];
  channels?: string[];
  slaWarnMinutes?: number;
  slaLateMinutes?: number;
  sound?: boolean;
  fontScale?: number;
}

interface KdsScreen {
  id: string;
  name: string;
  station: string;
  locationId: string;
  isActive: boolean;
  settings: KdsScreenSettings | null;
}

interface TicketItem {
  id: string;
  name: string;
  quantity: number;
  modifiers: Array<{ name: string; quantity?: number }>;
  notes?: string | null;
}

interface KdsTicket {
  kdsScreenId: string;
  orderId: string;
  createdAt: string;
  bumpedAt: string | null;
  metadata?: {
    itemIds?: string[];
    itemStates?: Record<string, string>;
  } | null;
  order: {
    id: string;
    displayId: string | null;
    orderNumber?: number | null;
    orderSource: string;
    platform: string;
    fulfillmentType: string;
    status: string;
    scheduledFor?: string | null;
    courierStatus?: string | null;
    customerName?: string | null;
    specialInstructions?: string | null;
    items: TicketItem[];
    brand?: { name: string } | null;
  };
}

// ── Channel styling ──────────────────────────────────────────────────────────

const CHANNEL_CHIP: Record<string, { label: string; cls: string }> = {
  UBER_EATS: { label: "Uber Eats", cls: "bg-emerald-950 text-emerald-300" },
  DELIVEROO: { label: "Deliveroo", cls: "bg-teal-950 text-teal-300" },
  JUST_EAT: { label: "Just Eat", cls: "bg-orange-950 text-orange-300" },
  ONLINE: { label: "Online", cls: "bg-sky-950 text-sky-300" },
  POS: { label: "POS", cls: "bg-violet-950 text-violet-300" },
  WHATSAPP: { label: "WhatsApp", cls: "bg-green-950 text-green-300" },
  HUBRISE: { label: "Marketplace", cls: "bg-zinc-800 text-zinc-300" },
  DIRECT: { label: "Direct", cls: "bg-sky-950 text-sky-300" },
};

const TYPE_LABEL: Record<string, string> = {
  DELIVERY: "Delivery",
  PLATFORM_COURIER: "Delivery",
  MERCHANT_DELIVERY: "Own delivery",
  PICKUP: "Collection",
  DINE_IN: "Dine-in",
};

// ── Small hooks ──────────────────────────────────────────────────────────────

function useNowTick(ms = 1000) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function elapsedSeconds(createdAt: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
}

function fmtElapsed(secs: number) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Two-tone chime via WebAudio — no asset needed, survives cold caches. */
function useChime() {
  const ctxRef = useRef<AudioContext | null>(null);
  return useCallback(() => {
    try {
      ctxRef.current ??= new AudioContext();
      const ctx = ctxRef.current;
      if (ctx.state === "suspended") void ctx.resume();
      const play = (freq: number, at: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        osc.type = "sine";
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
        gain.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.5);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + at);
        osc.stop(ctx.currentTime + at + 0.55);
      };
      play(880, 0);
      play(1174, 0.18);
    } catch {
      /* audio blocked until first touch — fine */
    }
  }, []);
}

/** Keep the tablet awake while the KDS is open. */
function useWakeLock() {
  useEffect(() => {
    let lock: any = null;
    const acquire = async () => {
      try {
        lock = await (navigator as any).wakeLock?.request("screen");
      } catch {
        /* unsupported / denied */
      }
    };
    void acquire();
    const onVis = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      try {
        void lock?.release();
      } catch {
        /* noop */
      }
    };
  }, []);
}

// ── Page shell ───────────────────────────────────────────────────────────────

export default function KdsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center bg-zinc-950">
          <div className="h-8 w-8 rounded-full border-2 border-zinc-700 border-t-emerald-500 animate-spin" />
        </div>
      }
    >
      <KdsPageInner />
    </Suspense>
  );
}

function KdsPageInner() {
  const params = useSearchParams();
  const screenId = params.get("screen") ?? "";

  // /kds is its own root — a full page load here doesn't mount the dashboard
  // tree, so we import the auth store directly (which registers the Axios
  // token callbacks) and wait for its persisted tokens to rehydrate before
  // firing any API call. Without this, a fresh load logs the operator out.
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(true);
  useEffect(() => {
    const check = () => {
      const st = useAuthStore.getState();
      setAuthed(!!st.accessToken);
      setReady(true);
    };
    // Rehydrate from localStorage, then read the live token.
    const p = (useAuthStore as any).persist?.rehydrate?.();
    if (p && typeof p.then === "function") p.then(check);
    else check();
  }, []);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950">
        <div className="h-8 w-8 rounded-full border-2 border-zinc-700 border-t-emerald-500 animate-spin" />
      </div>
    );
  }
  if (!authed) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-white">
        <div className="text-center">
          <p className="text-lg font-medium mb-1">Please sign in</p>
          <p className="text-sm text-zinc-500 mb-4">
            Your session isn't active on this device.
          </p>
          <button
            onClick={() =>
              window.location.assign(
                `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
              )
            }
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500"
          >
            Go to sign in
          </button>
        </div>
      </div>
    );
  }

  if (!screenId) return <ScreenPicker />;
  return <StationView screenId={screenId} />;
}

// ── Screen picker (no ?screen= yet) ─────────────────────────────────────────

function ScreenPicker() {
  const router = useRouter();
  const { data: locations = [] } = useQuery<any[]>({
    queryKey: ["kds-locations"],
    queryFn: () => apiClient.get("/v1/locations").then((r) => r.data),
  });
  const [locationId, setLocationId] = useState<string>("");
  const effectiveLocation = locationId || locations[0]?.id || "";

  const { data: screens = [] } = useQuery<KdsScreen[]>({
    queryKey: ["kds-screens", effectiveLocation],
    queryFn: () =>
      apiClient
        .get(`/v1/kds/screens?locationId=${effectiveLocation}`)
        .then((r) => r.data),
    enabled: !!effectiveLocation,
  });

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <div className="flex items-center gap-3 mb-6">
          <Monitor className="h-7 w-7 text-emerald-400" />
          <h1 className="text-2xl font-semibold flex-1">Kitchen display</h1>
          <button
            onClick={() => window.location.assign("/dashboard/orders/kitchen")}
            className="text-sm text-zinc-400 hover:text-zinc-200"
          >
            Back to dashboard
          </button>
        </div>
        {locations.length > 1 && (
          <select
            value={effectiveLocation}
            onChange={(e) => setLocationId(e.target.value)}
            className="w-full mb-4 rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2.5 text-sm"
          >
            {locations.map((l: any) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
        <div className="grid gap-3">
          {screens.filter((s) => s.isActive).map((s) => (
            <button
              key={s.id}
              onClick={() => router.push(`/kds?screen=${s.id}`)}
              className="flex items-center justify-between rounded-xl bg-zinc-900 border border-zinc-800 hover:border-emerald-600 px-5 py-4 text-left transition-colors"
            >
              <div>
                <p className="font-semibold">{s.name}</p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {(s.settings?.stationType === "EXPO" ? "Expo" : "Station") +
                    " · " +
                    s.station}
                </p>
              </div>
              <span className="text-emerald-400 text-sm">Open →</span>
            </button>
          ))}
          {screens.length === 0 && effectiveLocation && (
            <p className="text-sm text-zinc-500">
              No screens yet — create one under Dashboard → Settings → Kitchen
              screens.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Station view ─────────────────────────────────────────────────────────────

function StationView({ screenId }: { screenId: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const chime = useChime();
  useWakeLock();
  useNowTick();

  const [soundEnabled, setSoundEnabled] = useState(true);
  const [fontScale, setFontScale] = useState(1);
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    const stored = Number(localStorage.getItem("kds:fontScale") ?? "1");
    if (stored >= 0.8 && stored <= 1.6) setFontScale(stored);
  }, []);
  const bumpFont = (d: number) =>
    setFontScale((f) => {
      const next = Math.min(1.6, Math.max(0.8, Math.round((f + d) * 10) / 10));
      localStorage.setItem("kds:fontScale", String(next));
      return next;
    });

  const { data: screen } = useQuery<KdsScreen>({
    queryKey: ["kds-screen", screenId],
    queryFn: () => apiClient.get(`/v1/kds/screens/${screenId}`).then((r) => r.data),
  });
  const settings: KdsScreenSettings = screen?.settings ?? {};
  const warnSecs = (settings.slaWarnMinutes ?? 5) * 60;
  const lateSecs = (settings.slaLateMinutes ?? 10) * 60;

  const { data: siblingScreens = [] } = useQuery<KdsScreen[]>({
    queryKey: ["kds-screens", screen?.locationId],
    queryFn: () =>
      apiClient
        .get(`/v1/kds/screens?locationId=${screen!.locationId}`)
        .then((r) => r.data),
    enabled: !!screen?.locationId,
  });

  const { data: tickets = [] } = useQuery<KdsTicket[]>({
    queryKey: ["kds-tickets", screenId],
    queryFn: () =>
      apiClient.get(`/v1/kds/screens/${screenId}/tickets`).then((r) => r.data),
    refetchInterval: 20_000,
  });

  const { data: bumped = [] } = useQuery<KdsTicket[]>({
    queryKey: ["kds-bumped", screenId],
    queryFn: () =>
      apiClient.get(`/v1/kds/screens/${screenId}/bumped`).then((r) => r.data),
    refetchInterval: 60_000,
  });

  const { data: stats } = useQuery<{
    openCount: number;
    lateCount: number;
    doneToday: number;
    avgBumpSeconds: number;
  }>({
    queryKey: ["kds-stats", screenId],
    queryFn: () =>
      apiClient.get(`/v1/kds/screens/${screenId}/stats`).then((r) => r.data),
    refetchInterval: 60_000,
  });

  const refetchAll = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["kds-tickets", screenId] });
    void qc.invalidateQueries({ queryKey: ["kds-bumped", screenId] });
    void qc.invalidateQueries({ queryKey: ["kds-stats", screenId] });
  }, [qc, screenId]);

  // Live updates.
  useEffect(() => {
    const socket = socketClient.getSocket();
    if (!socket) return;
    const onNew = (ticket: any) => {
      refetchAll();
      if (ticket?.kdsScreenId === screenId && soundEnabled) chime();
    };
    const onAny = () => refetchAll();
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    socket.on("kds:ticket:new", onNew);
    socket.on("kds:order:new", onAny);
    socket.on("kds:ticket:bumped", onAny);
    socket.on("kds:ticket:recalled", onAny);
    socket.on("kds:ticket:void", onAny);
    socket.on("kds:item:state", onAny);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    setConnected(socket.connected);
    return () => {
      socket.off("kds:ticket:new", onNew);
      socket.off("kds:order:new", onAny);
      socket.off("kds:ticket:bumped", onAny);
      socket.off("kds:ticket:recalled", onAny);
      socket.off("kds:ticket:void", onAny);
      socket.off("kds:item:state", onAny);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [screenId, soundEnabled, chime, refetchAll]);

  const bumpMutation = useMutation({
    mutationFn: (orderId: string) =>
      apiClient.post(`/v1/kds/screens/${screenId}/tickets/${orderId}/bump`, {}),
    onSuccess: refetchAll,
  });
  const recallMutation = useMutation({
    mutationFn: (orderId: string) =>
      apiClient.post(`/v1/kds/screens/${screenId}/tickets/${orderId}/recall`, {}),
    onSuccess: refetchAll,
  });
  const itemStateMutation = useMutation({
    mutationFn: (v: { orderId: string; itemId: string; done: boolean }) =>
      apiClient.post(
        `/v1/kds/screens/${screenId}/tickets/${v.orderId}/items/${v.itemId}/state`,
        { done: v.done },
      ),
    onSuccess: refetchAll,
  });

  const active = tickets.filter((t) => !t.bumpedAt);

  // All-day production counter across visible tickets.
  const allDay = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of active) {
      const routed = t.metadata?.itemIds ?? [];
      for (const it of t.order.items) {
        if (routed.length && !routed.includes(it.id)) continue;
        counts.set(it.name, (counts.get(it.name) ?? 0) + it.quantity);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  }, [active]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen().catch(() => {});
    } else {
      void document.exitFullscreen().catch(() => {});
    }
  };

  return (
    <div
      className="h-screen bg-zinc-950 flex flex-col overflow-hidden select-none"
      style={{ zoom: fontScale } as any}
    >
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-900 border-b border-zinc-800 flex-shrink-0 gap-3">
        <div className="flex items-center gap-1 overflow-x-auto">
          <button
            onClick={() => {
              if (document.fullscreenElement) {
                void document.exitFullscreen().catch(() => {});
              }
              // Full page load, not client nav: the tab may predate the
              // latest deploy and stale chunk fetches crash client routing.
              window.location.assign("/dashboard/orders/kitchen");
            }}
            title="Close display"
            className="flex-shrink-0 p-1.5 mr-1 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800"
          >
            <X className="h-5 w-5" />
          </button>
          {siblingScreens
            .filter((s) => s.isActive)
            .map((s) => (
              <button
                key={s.id}
                onClick={() => router.push(`/kds?screen=${s.id}`)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-sm font-semibold whitespace-nowrap transition-colors",
                  s.id === screenId
                    ? "bg-zinc-100 text-zinc-900"
                    : "text-zinc-400 hover:text-zinc-200",
                )}
              >
                {s.name}
              </button>
            ))}
        </div>
        <div className="flex items-center gap-4 text-sm text-zinc-400 whitespace-nowrap">
          {stats && (
            <>
              <span>avg {fmtElapsed(stats.avgBumpSeconds)}</span>
              <span>
                {active.length} open · {stats.doneToday} done
              </span>
              {stats.lateCount > 0 && (
                <span className="text-red-400 font-semibold">
                  {stats.lateCount} late
                </span>
              )}
            </>
          )}
          {!connected && (
            <span className="flex items-center gap-1.5 rounded-md bg-red-950 text-red-300 px-2 py-1 text-xs font-semibold">
              <WifiOff className="h-3.5 w-3.5" /> offline — reconnecting
            </span>
          )}
          <div className="flex items-center gap-1">
            <button
              onClick={() => bumpFont(-0.1)}
              className="px-2 py-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 text-xs font-bold"
            >
              A−
            </button>
            <button
              onClick={() => bumpFont(0.1)}
              className="px-2 py-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 text-sm font-bold"
            >
              A+
            </button>
            <button
              onClick={() => setSoundEnabled((p) => !p)}
              className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
            >
              {soundEnabled ? (
                <Volume2 className="h-4 w-4" />
              ) : (
                <VolumeX className="h-4 w-4" />
              )}
            </button>
            <button
              onClick={toggleFullscreen}
              className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* ── Body: rail + all-day ── */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-y-auto p-3">
          {active.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="h-16 w-16 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto mb-4">
                  <Check className="h-8 w-8 text-emerald-500" />
                </div>
                <p className="text-zinc-400 text-lg font-medium">All clear</p>
              </div>
            </div>
          ) : (
            <div
              className="grid gap-3"
              style={{
                gridTemplateColumns: `repeat(auto-fill, minmax(240px, 1fr))`,
              }}
            >
              {active.map((t) => (
                <TicketCard
                  key={t.orderId}
                  ticket={t}
                  isExpo={settings.stationType === "EXPO"}
                  warnSecs={warnSecs}
                  lateSecs={lateSecs}
                  onBump={() => bumpMutation.mutate(t.orderId)}
                  onToggleItem={(itemId, done) =>
                    itemStateMutation.mutate({
                      orderId: t.orderId,
                      itemId,
                      done,
                    })
                  }
                />
              ))}
            </div>
          )}
        </div>

        {allDay.length > 0 && (
          <div className="w-52 flex-shrink-0 border-l border-zinc-800 bg-zinc-900/60 overflow-y-auto p-3">
            <p className="text-[11px] uppercase tracking-widest text-zinc-500 mb-2 font-semibold">
              All day
            </p>
            {allDay.map(([name, qty]) => (
              <div
                key={name}
                className="flex items-start justify-between gap-2 py-1.5 border-b border-zinc-800/60 text-sm"
              >
                <span className="text-zinc-300 leading-tight">{name}</span>
                <span className="text-white font-bold">{qty}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Recall rail ── */}
      {bumped.length > 0 && (
        <div className="border-t border-zinc-800 bg-zinc-900 px-3 py-2 flex items-center gap-2 flex-shrink-0 overflow-x-auto">
          <span className="text-[11px] uppercase tracking-widest text-zinc-500 font-semibold flex-shrink-0">
            Recall
          </span>
          {bumped.map((t) => (
            <button
              key={t.orderId}
              onClick={() => recallMutation.mutate(t.orderId)}
              className="flex-shrink-0 flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
            >
              <RotateCcw className="h-3 w-3" />#
              {t.order.displayId ??
                t.order.orderNumber ??
                t.orderId.slice(-4)}{" "}
              ·{" "}
              {t.bumpedAt
                ? fmtElapsed(elapsedSeconds(t.bumpedAt)) + " ago"
                : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Ticket card ──────────────────────────────────────────────────────────────

function TicketCard({
  ticket,
  isExpo,
  warnSecs,
  lateSecs,
  onBump,
  onToggleItem,
}: {
  ticket: KdsTicket;
  isExpo: boolean;
  warnSecs: number;
  lateSecs: number;
  onBump: () => void;
  onToggleItem: (itemId: string, done: boolean) => void;
}) {
  const elapsed = elapsedSeconds(ticket.createdAt);
  const sla = elapsed >= lateSecs ? "late" : elapsed >= warnSecs ? "warn" : "ok";
  const order = ticket.order;
  const chip = CHANNEL_CHIP[order.orderSource] ?? {
    label: order.orderSource,
    cls: "bg-zinc-800 text-zinc-300",
  };
  const routed = ticket.metadata?.itemIds ?? [];
  const itemStates = ticket.metadata?.itemStates ?? {};
  const items = routed.length
    ? order.items.filter((i) => routed.includes(i.id))
    : order.items;
  const riderWaiting =
    !!order.courierStatus && /pickup|arriv|wait/i.test(order.courierStatus);
  const isAllergy = (s?: string | null) => !!s && /allerg/i.test(s);

  const headerCls =
    sla === "late"
      ? "bg-red-950 text-red-100"
      : sla === "warn"
        ? "bg-amber-950 text-amber-100"
        : "bg-zinc-800 text-zinc-100";
  const timerCls =
    sla === "late"
      ? "text-red-300"
      : sla === "warn"
        ? "text-amber-300"
        : "text-emerald-300";
  const borderCls =
    sla === "late"
      ? "border-t-red-500"
      : sla === "warn"
        ? "border-t-amber-500"
        : "border-t-emerald-500";

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl bg-zinc-900 border-t-4 overflow-hidden",
        borderCls,
      )}
    >
      <div className={cn("px-3 py-2 flex items-center justify-between", headerCls)}>
        <span className="font-bold text-lg leading-none">
          #{order.displayId ?? order.orderNumber ?? order.id.slice(-4).toUpperCase()}
          {order.customerName ? (
            <span className="font-medium text-sm opacity-70">
              {" "}
              · {order.customerName.split(" ")[0]}
            </span>
          ) : null}
        </span>
        <span className={cn("font-mono font-bold text-base", timerCls, sla === "late" && "animate-pulse")}>
          {fmtElapsed(elapsed)}
        </span>
      </div>

      <div className="flex-1 px-3 py-2 space-y-1.5 overflow-y-auto max-h-[22rem]">
        <div className="flex flex-wrap gap-1.5 mb-1">
          <span className={cn("text-[11px] font-semibold px-1.5 py-0.5 rounded", chip.cls)}>
            {chip.label}
          </span>
          <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
            {TYPE_LABEL[order.fulfillmentType] ?? order.fulfillmentType}
          </span>
          {order.brand?.name && (
            <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
              {order.brand.name}
            </span>
          )}
          {order.scheduledFor && (
            <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-sky-950 text-sky-300 flex items-center gap-1">
              <CalendarClock className="h-3 w-3" />
              {new Date(order.scheduledFor).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
          {riderWaiting && (
            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded bg-red-950 text-red-300 flex items-center gap-1 animate-pulse">
              <Bike className="h-3 w-3" /> Rider waiting
            </span>
          )}
        </div>

        {items.map((item) => {
          const done = !!itemStates[item.id];
          return (
            <button
              key={item.id}
              onClick={() => onToggleItem(item.id, !done)}
              className="block w-full text-left"
            >
              <p
                className={cn(
                  "font-semibold text-[15px] leading-tight",
                  done ? "text-zinc-600 line-through" : "text-white",
                )}
              >
                <span className={done ? "text-zinc-600" : "text-emerald-400"}>
                  {item.quantity}×
                </span>{" "}
                {item.name}
              </p>
              {!done &&
                item.modifiers?.map((mod, j) => (
                  <p key={j} className="text-[13px] text-zinc-400 ml-5 leading-snug">
                    + {mod.quantity && mod.quantity > 1 ? `${mod.quantity}× ` : ""}
                    {mod.name}
                  </p>
                ))}
              {!done && item.notes && (
                <p
                  className={cn(
                    "text-[13px] ml-5 font-medium",
                    isAllergy(item.notes) ? "text-red-400" : "text-amber-300",
                  )}
                >
                  {isAllergy(item.notes) && (
                    <AlertTriangle className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
                  )}
                  {item.notes}
                </p>
              )}
            </button>
          );
        })}

        {order.specialInstructions && (
          <div
            className={cn(
              "mt-1.5 rounded-md px-2 py-1.5 text-[13px] font-medium",
              isAllergy(order.specialInstructions)
                ? "bg-red-950 text-red-300"
                : "bg-amber-950/60 text-amber-300",
            )}
          >
            {isAllergy(order.specialInstructions) && (
              <AlertTriangle className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
            )}
            {order.specialInstructions}
          </div>
        )}
      </div>

      <button
        onClick={onBump}
        className={cn(
          "w-full py-3 font-bold text-sm flex items-center justify-center gap-2 transition-colors",
          sla === "late"
            ? "bg-red-900 hover:bg-red-800 text-red-100"
            : sla === "warn"
              ? "bg-amber-900 hover:bg-amber-800 text-amber-100"
              : "bg-emerald-800 hover:bg-emerald-700 text-emerald-50",
        )}
      >
        <Check className="h-4 w-4" />
        {isExpo ? "SERVE" : "BUMP"}
      </button>
    </div>
  );
}
