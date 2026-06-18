"use client";

// Phase AN — Deliverect-style Locations list.
//
// Layout: search + filter + create button on top, expandable cards below.
// Each card carries action chips (POS settings / Channel link / Opening
// hours / Busy mode / More) and reveals brand-platform connections when
// expanded.

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
} from "lucide-react";
import { locationsClient, type Location } from "@/lib/api/locations.client";
import { useSelectedLocationStore } from "@/stores/selected-location.store";
import { useAuthStore } from "@/stores/auth.store";

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
import { LocationBrandsDrawer } from "@/components/locations/location-brands-drawer";
import { DeleteLocationModal } from "@/components/locations/delete-location-modal";
import { Trash2 } from "lucide-react";

type Drawer =
  | { kind: "hours"; locationId: string }
  | { kind: "brands"; locationId: string }
  | { kind: "edit"; locationId: string | null } // null = create
  | { kind: "delete"; locationId: string; name: string }
  | null;

export default function LocationsPage() {
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
              onBrands={() => setDrawer({ kind: "brands", locationId: loc.id })}
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
      {drawer?.kind === "brands" && (
        <LocationBrandsDrawer locationId={drawer.locationId} onClose={closeDrawer} />
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
