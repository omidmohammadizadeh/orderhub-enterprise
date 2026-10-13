"use client";

// Pieces every salon screen shares: the section tabs, the live-update hook,
// status colours, and the "this location isn't a salon yet" set-up card.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { BarChart3, CalendarDays, Scissors, Settings2, Sparkles, Users, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth.store";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { getSocket, joinLocationRoom, leaveLocationRoom } from "@/lib/socket/socket.client";
import { queryKeys } from "@/lib/api/query-keys";
import {
  apiError,
  salonClient,
  STATUS_LABEL,
  type AppointmentStatus,
  type SalonTrade,
} from "@/lib/api/salon.client";

export const MANAGE_ROLES = ["PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "MANAGER", "DARK_KITCHEN_MANAGER"];

export function useCanManage(): boolean {
  const role = useAuthStore((s) => s.user?.role);
  return !!role && MANAGE_ROLES.includes(role);
}

export function useSalonLocation() {
  const locationId = useSelectedLocationStore((s) => s.selectedLocationId);
  const settings = useQuery({
    queryKey: ["salon", "settings", locationId],
    queryFn: () => salonClient.settings(locationId!),
    enabled: !!locationId,
    staleTime: 60_000,
  });
  return { locationId, settings };
}

export function useSalonServices(locationId: string | null | undefined) {
  return useQuery({
    queryKey: ["salon", "services", locationId],
    queryFn: () => salonClient.services(locationId!),
    enabled: !!locationId,
    staleTime: 60_000,
  });
}

export function useSalonStaff(locationId: string | null | undefined, archived = false) {
  return useQuery({
    queryKey: ["salon", "staff", locationId, archived],
    queryFn: () => salonClient.staff(locationId!, archived),
    enabled: !!locationId,
    staleTime: 60_000,
  });
}

/** Refresh salon screens the moment anything changes elsewhere (other till, online booking). */
export function useSalonLive(locationId: string | null | undefined) {
  const qc = useQueryClient();
  const token = useAuthStore((s) => s.accessToken);
  useEffect(() => {
    if (!locationId || !token) return;
    const socket = getSocket(token);
    joinLocationRoom(socket, locationId);
    let t: number | null = null;
    const bump = (key: string) => () => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["salon", key] });
        if (key === "appointments") qc.invalidateQueries({ queryKey: ["salon", "appointment"] });
      }, 400);
    };
    const onAppt = bump("appointments");
    const onQueue = bump("queue");
    socket.on("salon:changed" as any, onAppt as any);
    socket.on("salon:queue" as any, onQueue as any);
    return () => {
      if (t) window.clearTimeout(t);
      socket.off("salon:changed" as any, onAppt as any);
      socket.off("salon:queue" as any, onQueue as any);
      leaveLocationRoom(socket, locationId);
    };
  }, [locationId, token, qc]);
}

const TABS = [
  { href: "/dashboard/salon", label: "Diary", icon: CalendarDays, exact: true },
  { href: "/dashboard/salon/queue", label: "Walk-ins", icon: UsersRound },
  { href: "/dashboard/salon/services", label: "Services", icon: Scissors, manage: true },
  { href: "/dashboard/salon/team", label: "Team", icon: Users, manage: true },
  { href: "/dashboard/salon/reports", label: "Reports", icon: BarChart3, manage: true },
  { href: "/dashboard/salon/settings", label: "Settings", icon: Settings2, manage: true },
];

export function SalonTabs({ right }: { right?: React.ReactNode }) {
  const pathname = usePathname();
  const canManage = useCanManage();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <nav aria-label="Salon sections" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {TABS.filter((t) => !t.manage || canManage).map((t) => {
          const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                active ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {t.label}
            </Link>
          );
        })}
      </nav>
      {right}
    </div>
  );
}

export const STATUS_BLOCK: Record<AppointmentStatus, string> = {
  PENDING_PAYMENT: "border-amber-400 bg-amber-50 text-amber-950",
  CONFIRMED: "border-sky-500 bg-sky-50 text-sky-950",
  CHECKED_IN: "border-violet-500 bg-violet-50 text-violet-950",
  IN_SERVICE: "border-emerald-500 bg-emerald-50 text-emerald-950",
  COMPLETED: "border-zinc-300 bg-zinc-50 text-zinc-500",
  CANCELLED: "border-red-300 bg-red-50/60 text-red-400 line-through",
  NO_SHOW: "border-red-300 bg-red-50/60 text-red-400",
};

export const STATUS_PILL: Record<AppointmentStatus, string> = {
  PENDING_PAYMENT: "bg-amber-100 text-amber-800",
  CONFIRMED: "bg-sky-100 text-sky-800",
  CHECKED_IN: "bg-violet-100 text-violet-800",
  IN_SERVICE: "bg-emerald-100 text-emerald-800",
  COMPLETED: "bg-zinc-100 text-zinc-600",
  CANCELLED: "bg-red-100 text-red-700",
  NO_SHOW: "bg-red-100 text-red-700",
};

export function StatusPill({ status }: { status: AppointmentStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_PILL[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function staffWord(trade: SalonTrade | undefined, plural = false): string {
  const map: Record<SalonTrade, [string, string]> = {
    BARBER: ["Barber", "Barbers"],
    HAIR: ["Stylist", "Stylists"],
    NAILS: ["Nail tech", "Nail techs"],
    BEAUTY: ["Therapist", "Therapists"],
  };
  return (map[trade ?? "BARBER"] ?? map.BARBER)[plural ? 1 : 0];
}

const TRADES: Array<{ value: SalonTrade; label: string; hint: string }> = [
  { value: "BARBER", label: "Barbers", hint: "Short slots, walk-in queue on, starter price list of cuts and shaves." },
  { value: "HAIR", label: "Hair salon", hint: "Colour with processing time, patch tests, deposits on long bookings." },
  { value: "NAILS", label: "Nail salon", hint: "Gel, acrylic and BIAB, removals as add-ons." },
  { value: "BEAUTY", label: "Beauty", hint: "Brows, lashes, waxing and facials." },
];

/** Shown on every salon screen until the selected location is a salon. */
export function SalonSetupCard({
  locationId,
  locationName,
  alreadySalon,
}: {
  locationId: string;
  locationName?: string;
  /** Business type is already SALON (set in the location editor) — only the set-up is left. */
  alreadySalon?: boolean;
}) {
  const qc = useQueryClient();
  const canManage = useCanManage();
  const [trade, setTrade] = useState<SalonTrade>("BARBER");
  const [name, setName] = useState("");
  const [starter, setStarter] = useState(true);
  const enable = useMutation({
    mutationFn: () => salonClient.enable({ locationId, trade, starterServices: starter, firstStaffName: name.trim() || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["salon"] });
      qc.invalidateQueries({ queryKey: queryKeys.locationDetail(locationId) });
      toast.success("You're set up — add your team's hours next");
    },
    onError: (e) => toast.error(apiError(e, "Couldn't switch this location over")),
  });
  return (
    <section className="mx-auto max-w-2xl rounded-2xl border border-zinc-200 bg-white p-6 shadow-card-sm">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-orange-100 text-orange-600">
          <Sparkles className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">
            {alreadySalon ? `Finish setting up ${locationName ?? "this location"}` : `Run ${locationName ?? "this location"} as a salon`}
          </h2>
          <p className="text-sm text-zinc-500">
            {alreadySalon
              ? "One step left: pick the kind of business and your first team member. Appointments and Walk-ins open straight after."
              : "Appointments, a walk-in queue and online booking, paid through your till."}
          </p>
        </div>
      </div>
      {!canManage ? (
        <p className="mt-5 text-sm text-zinc-600">Ask an owner or manager to switch this location to a salon.</p>
      ) : (
        <form
          className="mt-5 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            enable.mutate();
          }}
        >
          <fieldset>
            <legend className="text-sm font-medium text-zinc-800">What kind of business is it?</legend>
            <div role="radiogroup" className="mt-2 grid gap-2 sm:grid-cols-2">
              {TRADES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={trade === t.value}
                  onClick={() => setTrade(t.value)}
                  className={`rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                    trade === t.value ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 hover:border-zinc-400"
                  }`}
                >
                  <span className="block text-sm font-semibold">{t.label}</span>
                  <span className={`mt-0.5 block text-xs ${trade === t.value ? "text-zinc-300" : "text-zinc-500"}`}>{t.hint}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <label className="block">
            <span className="text-sm font-medium text-zinc-800">First {staffWord(trade).toLowerCase()}&rsquo;s name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Jay"
              autoComplete="off"
              className="mt-1 h-10 w-full rounded-lg border border-zinc-200 px-3 text-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-200"
            />
            <span className="mt-1 block text-xs text-zinc-500">You can add the rest of the team after.</span>
          </label>
          <label className="flex items-start gap-2 text-sm text-zinc-700">
            <input type="checkbox" checked={starter} onChange={(e) => setStarter(e.target.checked)} className="mt-0.5 h-4 w-4 accent-orange-500" />
            <span>Start me with a typical price list I can edit</span>
          </label>
          <Button type="submit" loading={enable.isPending}>
            {alreadySalon ? "Finish set-up" : "Switch to salon"}
          </Button>
        </form>
      )}
    </section>
  );
}

/** The page frame: header, tabs, and the set-up gate. */
export function SalonFrame({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { locationId, settings } = useSalonLocation();
  useSalonLive(locationId);
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-zinc-500">{subtitle}</p>}
        </div>
      </header>
      {!locationId ? (
        <p className="rounded-2xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500">
          Pick a location from the menu to see its diary.
        </p>
      ) : settings.isLoading ? (
        <div className="h-40 animate-pulse rounded-2xl bg-zinc-100" />
      ) : settings.isError ? (
        <p className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          {apiError(settings.error, "Couldn't load this location")}
        </p>
      ) : !settings.data?.isSalon || !settings.data?.configured ? (
        <SalonSetupCard
          locationId={locationId}
          locationName={settings.data?.locationName}
          alreadySalon={!!settings.data?.isSalon}
        />
      ) : (
        <>
          <SalonTabs right={right} />
          {children}
        </>
      )}
    </div>
  );
}

/** A field with no width of its own — for fixed-width or flex cells. */
export const inputBase =
  "h-10 rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-200 disabled:bg-zinc-50";
export const inputCls = `${inputBase} w-full`;
