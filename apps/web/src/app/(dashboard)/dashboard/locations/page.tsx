"use client";

// Phase AN — Deliverect-style Locations list.
//
// Layout: search + filter + create button on top, expandable cards below.
// Each card carries action chips (POS settings / Channel link / Opening
// hours / Busy mode / More) and reveals brand-platform connections when
// expanded.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  Plus,
  Search as SearchIcon,
  Clock,
  Tag,
  Building,
  Settings,
  MoreHorizontal,
  Loader2,
  Copy,
  Check,
  Lock,
  Unlock,
} from "lucide-react";
import toast from "react-hot-toast";
import { locationsClient, type Location } from "@/lib/api/locations.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { useAuthStore } from "@/stores/auth.store";
import { queryKeys } from "@/lib/api/query-keys";

// Roles allowed to create new locations and open the per-location
// settings drawer. OWNER + DARK_KITCHEN_MANAGER run their stores but
// don't get to add new ones or edit the underlying record — that's
// tenant ownership / onboarding territory.
const CAN_MANAGE_LOCATIONS = new Set([
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "ONBOARDING_AGENT",
]);
import { LocationEditModal } from "@/components/locations/location-edit-modal";
import { OpeningHoursDrawer } from "@/components/locations/opening-hours-drawer";
import { DeleteLocationModal } from "@/components/locations/delete-location-modal";
import { Trash2 } from "lucide-react";

type Drawer =
  | { kind: "hours"; locationId: string }
  | { kind: "edit"; locationId: string | null } // null = create
  | { kind: "delete"; locationId: string; name: string }
  | null;

export default function LocationsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const myRole = useAuthStore((s) => s.user?.role);
  const canManage = !!myRole && CAN_MANAGE_LOCATIONS.has(myRole);
  const locationsQuery = useQuery({
    queryKey: ["locations", "list"],
    queryFn: locationsClient.list,
  });

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "suspended" | "closed">("all");

  // Returning from the Uber Eats OAuth flow (the callback lands here since
  // the connect card lives in the Brands drawer). Surface the result, then
  // clean the query so a refresh doesn't re-toast.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    const ok = p.get("ubereats_connected");
    const oauthErr = p.get("ubereats_error");
    if (!ok && !oauthErr) return;
    if (oauthErr) {
      toast.error(`Uber Eats connect failed: ${oauthErr}`);
    } else if (ok === "1") {
      toast.success("Uber Eats store connected — open Brands to see it.");
    } else if (ok === "pick") {
      toast("Uber Eats authorised — open Brands and pick your store.", {
        icon: "🏬",
      });
    }
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const closeDrawer = () => setDrawer(null);
  const onSaved = () => {
    qc.invalidateQueries({ queryKey: ["locations"] });
    closeDrawer();
  };

  // Phase AR — narrow to the sidebar switcher's selected location.
  // "All locations" (null) keeps every row visible; picking a specific
  // location restricts the page to just that one card so the operator
  // can't accidentally edit a sibling's settings.
  const selectedLocationId = useSelectedLocationStore(
    (s) => s.selectedLocationId,
  );

  const filteredLocations = useMemo(() => {
    const all = locationsQuery.data ?? [];
    const q = search.trim().toLowerCase();
    return all.filter((l) => {
      if (selectedLocationId && l.id !== selectedLocationId) return false;
      if (statusFilter !== "all" && (l.status ?? "active") !== statusFilter) return false;
      if (!q) return true;
      return (
        l.name.toLowerCase().includes(q) ||
        (l.postcode ?? "").toLowerCase().includes(q) ||
        (l.city ?? "").toLowerCase().includes(q)
      );
    });
  }, [locationsQuery.data, search, statusFilter, selectedLocationId]);

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Locations</h1>
          <p className="text-sm text-zinc-500">
            Restaurants and stores in your network — opening hours, brands, channels.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDrawer({ kind: "edit", locationId: null })}
          disabled={!canManage}
          title={
            canManage
              ? undefined
              : "Only tenant owners and onboarding agents can add locations."
          }
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-4 w-4" /> Add location
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, city or postcode"
            className="w-full rounded-lg border border-zinc-200 bg-white px-9 py-2 text-sm focus:border-zinc-900 focus:outline-none"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as any)}
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="closed">Closed</option>
        </select>
      </div>

      {locationsQuery.isLoading ? (
        <EmptyState text="Loading locations…" />
      ) : filteredLocations.length === 0 ? (
        <EmptyState text={search ? "No locations match." : "No locations yet — add your first."} />
      ) : (
        <ul className="space-y-2">
          {filteredLocations.map((loc) => (
            <LocationCard
              key={loc.id}
              location={loc}
              expanded={expanded.has(loc.id)}
              onToggleExpand={() => toggleExpanded(loc.id)}
              onEdit={() => setDrawer({ kind: "edit", locationId: loc.id })}
              onHours={() => setDrawer({ kind: "hours", locationId: loc.id })}
              onBrands={() => router.push(`/dashboard/locations/${loc.id}/brands`)}
              onDelete={() =>
                setDrawer({ kind: "delete", locationId: loc.id, name: loc.name })
              }
              canManage={canManage}
            />
          ))}
        </ul>
      )}

      {drawer?.kind === "edit" && (
        <LocationEditModal
          locationId={drawer.locationId}
          onClose={closeDrawer}
          onSaved={onSaved}
        />
      )}
      {drawer?.kind === "hours" && (
        <OpeningHoursDrawer
          locationId={drawer.locationId}
          allLocations={locationsQuery.data ?? []}
          onClose={closeDrawer}
        />
      )}
      {drawer?.kind === "delete" && (
        <DeleteLocationModal
          locationId={drawer.locationId}
          locationName={drawer.name}
          onClose={closeDrawer}
          onDeleted={onSaved}
        />
      )}
    </div>
  );
}

function LocationCard({
  location,
  expanded,
  onToggleExpand,
  onEdit,
  onHours,
  onBrands,
  onDelete,
  canManage,
}: {
  location: Location;
  expanded: boolean;
  onToggleExpand: () => void;
  onEdit: () => void;
  onHours: () => void;
  onBrands: () => void;
  onDelete: () => void;
  canManage: boolean;
}) {
  const address = [location.addressLine1, location.city, location.postcode]
    .filter(Boolean)
    .join(", ");
  const channelCount = location._count?.platformConnections ?? 0;
  const status = location.status ?? "active";

  return (
    <li className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="flex items-center gap-3 px-4 py-3">
        {location.logoUrl ? (
          <img
            src={location.logoUrl}
            alt=""
            className="h-9 w-9 flex-shrink-0 rounded object-cover"
          />
        ) : (
          <div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded bg-zinc-100">
            <Building className="h-4 w-4 text-zinc-400" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-zinc-900 truncate">{location.name}</h3>
            <StatusBadge status={status} />
            <span className="text-[10px] text-zinc-400">
              {channelCount} channel link{channelCount === 1 ? "" : "s"}
            </span>
          </div>
          {address && <p className="mt-0.5 text-xs text-zinc-500 truncate">{address}</p>}
          <LocationIdChip id={location.id} />
        </div>
        <button
          type="button"
          onClick={onToggleExpand}
          className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100"
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 bg-zinc-50/40 px-4 py-2">
        {canManage && (
          <ActionChip icon={<Settings className="h-3 w-3" />} onClick={onEdit}>
            Location settings
          </ActionChip>
        )}
        <KioskLockChip location={location} />
        <ActionChip icon={<Clock className="h-3 w-3" />} onClick={onHours}>
          Opening hours
        </ActionChip>
        <ActionChip icon={<Tag className="h-3 w-3" />} onClick={onBrands}>
          Brands
        </ActionChip>
        {canManage && (
          <button
            type="button"
            onClick={onDelete}
            title="Delete location"
            className="ml-auto rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100"
          title="More (coming soon)"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>

      {expanded && <ExpandedSection locationId={location.id} />}
    </li>
  );
}

// Kiosk mode lock. When on, the dashboard chrome a customer must never
// touch — profile/sign-out, notifications, expand, search — is hidden on
// this location's screens. PLATFORM_ADMIN only: it is the difference
// between a locked-down kiosk and a tablet a customer can sign out of, so
// it should not be something a busy manager flips by accident.
function KioskLockChip({ location }: { location: any }) {
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const locked = !!(location?.settings as any)?.kiosk?.locked;

  const toggle = useMutation({
    mutationFn: () => {
      const settings = ((location?.settings ?? {}) as Record<string, any>);
      // The locations PATCH shallow-merges the TOP level only, so both
      // levels have to be spread or sibling settings are wiped.
      return locationsClient.update(location.id, {
        settings: {
          ...settings,
          kiosk: { ...(settings.kiosk ?? {}), locked: !locked },
        },
      } as any);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["locations"] });
      qc.invalidateQueries({ queryKey: queryKeys.locationDetail(location.id) });
      toast.success(locked ? "Kiosk mode unlocked" : "Kiosk mode locked");
    },
    onError: () => toast.error("Couldn't change kiosk mode"),
  });

  if (role !== "PLATFORM_ADMIN") return null;

  return (
    <ActionChip
      icon={locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
      onClick={() => toggle.mutate()}
    >
      {locked ? "Kiosk locked" : "Lock kiosk mode"}
    </ActionChip>
  );
}

// Copyable Location ID — shown on every location card so the id can be grabbed
// for integrations (WhatsApp, API, webhooks) without digging into the URL.
function LocationIdChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard
      ?.writeText(id)
      .then(() => {
        setCopied(true);
        toast.success("Location ID copied");
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error("Couldn't copy — copy it manually"));
  };
  return (
    <button
      type="button"
      onClick={copy}
      title="Copy location ID"
      className="mt-1 inline-flex max-w-full items-center gap-1 rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700"
    >
      <span className="truncate">ID: {id}</span>
      {copied ? (
        <Check className="h-3 w-3 flex-shrink-0 text-emerald-600" />
      ) : (
        <Copy className="h-3 w-3 flex-shrink-0" />
      )}
    </button>
  );
}

function ExpandedSection({ locationId }: { locationId: string }) {
  const detailQuery = useQuery({
    queryKey: ["locations", "detail", locationId],
    queryFn: () => locationsClient.get(locationId),
  });

  if (detailQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 border-t border-zinc-100 px-4 py-3 text-xs text-zinc-400">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading details…
      </div>
    );
  }
  const loc = detailQuery.data;
  if (!loc) return null;

  return (
    <div className="border-t border-zinc-100 px-4 py-3 space-y-2 text-xs">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <DataRow label="Phone" value={loc.phone} />
        <DataRow label="Timezone" value={loc.timezone} />
        <DataRow label="Custom domain" value={loc.customDomain} />
        <DataRow
          label="Online slug"
          value={loc.onlineOrderingSlug ? `/order/${loc.onlineOrderingSlug}` : null}
        />
        <DataRow label="Stripe acct" value={loc.stripeConnectedAccountId} />
        <DataRow label="Status" value={loc.status} />
      </div>
      {loc.about && <p className="text-zinc-500 italic">{loc.about}</p>}
    </div>
  );
}

function DataRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex gap-2">
      <span className="text-zinc-400 min-w-[80px]">{label}:</span>
      <span className="text-zinc-700 truncate">{value || "—"}</span>
    </div>
  );
}

function ActionChip({
  children,
  icon,
  onClick,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50"
    >
      {icon} {children}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    active: ["bg-emerald-50", "text-emerald-700"],
    suspended: ["bg-red-50", "text-red-700"],
    closed: ["bg-zinc-100", "text-zinc-500"],
  };
  const [bg, fg] = map[status] ?? ["bg-zinc-100", "text-zinc-500"];
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${bg} ${fg}`}>
      {status[0]!.toUpperCase() + status.slice(1)}
    </span>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-200 bg-white py-12 text-center text-sm text-zinc-400">
      {text}
    </div>
  );
}
