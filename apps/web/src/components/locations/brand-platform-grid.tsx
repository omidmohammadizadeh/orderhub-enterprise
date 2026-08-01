"use client";

// Phase AN — Brand × Platform connection cards.
//
// One row per supported platform — Just Eat, Uber Eats, Deliveroo, HubRise,
// Stuart, Uber Direct. Each card carries:
//   • platform logo + name
//   • status chip
//   • external store ID + integration ID inputs
//   • Connect / Edit / Disconnect actions
//
// For now everything is placeholder: status flips manually, OAuth flows
// ship in a later phase. The data flows through the
// /v1/brand-connections backend.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, RefreshCw, Settings, Trash2 } from "lucide-react";
import {
  brandConnectionsClient,
  brandsClient,
  type Brand,
  type BrandPlatformConnection,
  type ConnectionStatus,
  type PlatformId,
} from "@/lib/api/locations.client";
import { PlatformLogo, platformLabel } from "@/components/ui/platform-logo";
import { BrandSettingsDrawer } from "@/components/brands/brand-settings-drawer";
import { BrandChannelPricingSources } from "./brand-channel-pricing-sources";
import { UberEatsManageModal } from "@/components/locations/ubereats-manage-modal";
import { DeliverooManageModal } from "@/components/locations/deliveroo-manage-modal";
import { deliverooClient } from "@/lib/api/deliveroo.client";
import { apiClient } from "@/lib/api/client";
import { StorePickerModal } from "@/components/locations/store-picker-modal";
import toast from "react-hot-toast";

// Phase AU — HubRise lives on Location (not Brand) because the access
// token is generated against a HubRise location, not a brand. It's
// configured in Location settings → Integrations and intentionally
// removed from this brand-level grid to prevent the duplicate-setup
// foot-gun.
//
// Phase AW — DIRECT_ONLINE leads the list. It's the brand's own
// /brand/<slug> storefront, configured via the BrandSettingsDrawer
// rather than the inline external-store-id input the marketplace
// channels use.
const PLATFORMS: PlatformId[] = [
  "DIRECT_ONLINE",
  "JUST_EAT",
  "UBER_EATS",
  "DELIVEROO",
  "STUART",
  "UBER_DIRECT",
];

interface Props {
  brand: Brand;
  locationId: string;
}

export function BrandPlatformGrid({ brand, locationId }: Props) {
  const qc = useQueryClient();
  const brandId = brand.id;
  const connsQuery = useQuery({
    queryKey: ["brand-connections", brandId],
    queryFn: () => brandConnectionsClient.listForBrand(brandId),
  });

  // Phase AW — keep a live brand snapshot so the DIRECT_ONLINE row's
  // status (connected ↔ not_connected) updates immediately after the
  // settings drawer saves. The parent already has `brand` but it
  // doesn't refetch when the drawer mutates — refetch here.
  const brandQuery = useQuery({
    queryKey: ["brand", brandId],
    queryFn: () => brandsClient.get(brandId),
    initialData: brand,
  });
  const currentBrand = brandQuery.data ?? brand;

  const conns = connsQuery.data ?? [];

  const upsert = useMutation({
    mutationFn: brandConnectionsClient.upsert,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["brand-connections", brandId] }),
  });
  const disconnect = useMutation({
    mutationFn: brandConnectionsClient.disconnect,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["brand-connections", brandId] }),
  });

  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <ul className="space-y-1.5">
        {PLATFORMS.map((platform) => {
          // DIRECT_ONLINE is special: its connection state lives on the
          // Brand row itself (directOrderingEnabled + onlineOrderingSlug),
          // not on BrandPlatformConnection. Clicking Connect/Edit opens
          // the BrandSettingsDrawer instead of the inline store-id input.
          if (platform === "DIRECT_ONLINE") {
            const isConnected =
              !!currentBrand.directOrderingEnabled &&
              !!currentBrand.onlineOrderingSlug;
            return (
              <DirectOnlineRow
                key={platform}
                brand={currentBrand}
                connected={isConnected}
                onOpen={() => setSettingsOpen(true)}
              />
            );
          }
          const conn = conns.find((c) => c.platform === platform);
          // Uber Eats connects via OAuth — no external id. Connect opens
          // Uber's authorization page; the callback auto-links the store.
          if (platform === "UBER_EATS") {
            return (
              <UberEatsRow
                key={platform}
                brandId={brandId}
                locationId={locationId}
                connection={conn ?? null}
                onChanged={() =>
                  qc.invalidateQueries({ queryKey: ["brand-connections", brandId] })
                }
              />
            );
          }
          // Deliveroo is a real API connection: connecting resolves the
          // Deliveroo Brand ID from the Site ID and unlocks store controls.
          if (platform === "DELIVEROO") {
            return (
              <DeliverooRow
                key={platform}
                brandId={brandId}
                locationId={locationId}
                connection={conn ?? null}
                onChanged={() =>
                  qc.invalidateQueries({ queryKey: ["brand-connections", brandId] })
                }
              />
            );
          }
          return (
            <ConnectionRow
              key={platform}
              platform={platform}
              connection={conn ?? null}
              onConnect={(externalStoreId) =>
                upsert.mutate({
                  brandId,
                  locationId,
                  platform,
                  status: "pending",
                  externalStoreId,
                })
              }
              onUpdate={(patch) =>
                upsert.mutate({
                  brandId,
                  locationId,
                  platform,
                  ...patch,
                })
              }
              onDisconnect={() => {
                if (conn?.id) disconnect.mutate(conn.id);
              }}
              busy={upsert.isPending || disconnect.isPending}
            />
          );
        })}
      </ul>

      <BrandChannelPricingSources brandId={brandId} locationId={locationId} />

      <BrandSettingsDrawer
        brand={currentBrand}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["brand", brandId] });
          qc.invalidateQueries({ queryKey: ["brands"] });
        }}
      />
    </>
  );
}

function DirectOnlineRow({
  brand,
  connected,
  onOpen,
}: {
  brand: Brand;
  connected: boolean;
  onOpen: () => void;
}) {
  const publicUrl =
    brand.onlineOrderingSlug && typeof window !== "undefined"
      ? `${window.location.origin}/brand/${brand.onlineOrderingSlug}`
      : null;

  return (
    <li className="rounded-md border border-zinc-200 px-3 py-2">
      <div className="flex items-center gap-3">
        <PlatformLogo platform="DIRECT_ONLINE" size={44} />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-zinc-900">
              Direct online ordering
            </span>
            <StatusChip status={connected ? "connected" : "not_connected"} />
          </div>
          {connected && publicUrl ? (
            <a
              href={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate font-mono text-[10px] text-violet-600 hover:underline"
            >
              {publicUrl}
            </a>
          ) : (
            <p className="text-[10px] text-zinc-500">
              Brand's own storefront — set a URL, address, and Stripe Connect
              account.
            </p>
          )}
        </div>
        <button
          onClick={onOpen}
          className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-1 text-[10px] font-medium hover:bg-zinc-50"
        >
          <Settings className="h-3 w-3" />
          {connected ? "Settings" : "Connect"}
        </button>
      </div>
    </li>
  );
}

function ConnectionRow({
  platform,
  connection,
  onConnect,
  onUpdate,
  onDisconnect,
  busy,
}: {
  platform: PlatformId;
  connection: BrandPlatformConnection | null;
  onConnect: (externalStoreId: string) => void;
  onUpdate: (patch: { status?: ConnectionStatus; externalStoreId?: string | null }) => void;
  onDisconnect: () => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [storeId, setStoreId] = useState(connection?.externalStoreId ?? "");

  useEffect(() => {
    setStoreId(connection?.externalStoreId ?? "");
  }, [connection?.externalStoreId]);

  const status = connection?.status ?? "not_connected";
  const isConnected = status === "connected" || status === "pending";

  return (
    <li className="rounded-md border border-zinc-200 px-3 py-2">
      <div className="flex items-center gap-3">
        <PlatformLogo platform={platform} size={44} />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-zinc-900">{platformLabel(platform)}</span>
            <StatusChip status={status} />
          </div>
          {connection?.externalStoreId && !editing && (
            <p className="text-[10px] text-zinc-500">
              Store ID: {connection.externalStoreId}
            </p>
          )}
        </div>
        {editing ? (
          <div className="flex items-center gap-1">
            <input
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              placeholder="External store ID"
              className="w-44 rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-zinc-900 focus:outline-none"
            />
            <button
              onClick={() => {
                if (connection?.id) {
                  onUpdate({ externalStoreId: storeId || null });
                } else if (storeId) {
                  onConnect(storeId);
                }
                setEditing(false);
              }}
              disabled={busy}
              className="rounded-md bg-zinc-900 px-2 py-1 text-[10px] font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setStoreId(connection?.externalStoreId ?? "");
              }}
              className="rounded-md border border-zinc-200 px-2 py-1 text-[10px] hover:bg-zinc-50"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {!isConnected ? (
              <button
                onClick={() => setEditing(true)}
                className="rounded-md border border-zinc-300 px-2 py-1 text-[10px] font-medium hover:bg-zinc-50"
              >
                Connect
              </button>
            ) : (
              <>
                <button
                  onClick={() => setEditing(true)}
                  className="rounded p-1 text-zinc-500 hover:bg-zinc-100"
                  title="Edit"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  onClick={onDisconnect}
                  disabled={busy}
                  className="rounded p-1 text-zinc-500 hover:bg-red-50 hover:text-red-600"
                  title="Disconnect"
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function DeliverooRow({
  brandId,
  locationId,
  connection,
  onChanged,
}: {
  brandId: string;
  locationId: string;
  connection: BrandPlatformConnection | null;
  onChanged: () => void;
}) {
  const connected =
    connection?.status === "connected" || connection?.status === "suspended";
  // Post-connect management (open/close, hours, edit ids, disconnect) lives
  // in the Manage modal — the row stays compact.
  const [manageOpen, setManageOpen] = useState(false);
  const [storeId, setStoreId] = useState(connection?.externalStoreId ?? "");
  const [dBrandId, setDBrandId] = useState(connection?.externalBrandId ?? "");

  useEffect(() => {
    setStoreId(connection?.externalStoreId ?? "");
    setDBrandId(connection?.externalBrandId ?? "");
  }, [connection?.externalStoreId, connection?.externalBrandId]);

  const err = (e: any) =>
    toast.error(
      e?.response?.data?.message ?? e?.message ?? "Deliveroo request failed",
    );

  const connect = useMutation({
    mutationFn: () =>
      deliverooClient.connect({
        brandId,
        locationId,
        storeId: storeId.trim(),
        deliverooBrandId: dBrandId.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success("Deliveroo store connected");
      onChanged();
    },
    onError: err,
  });
  const showForm = !connected;

  return (
    <li className="rounded-md border border-zinc-200 px-3 py-2">
      <div className="flex items-start gap-3">
        <PlatformLogo platform="DELIVEROO" size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-zinc-900">Deliveroo</span>
            <StatusChip status={connection?.status ?? "not_connected"} />
          </div>

          {showForm ? (
            <div className="mt-1.5 space-y-1.5">
              <input
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
                placeholder="Site ID (e.g. rest-12345)"
                className="w-full rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-zinc-900 focus:outline-none"
              />
              <input
                value={dBrandId}
                onChange={(e) => setDBrandId(e.target.value)}
                placeholder="Deliveroo Brand ID (optional — auto-resolved)"
                className="w-full rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-zinc-900 focus:outline-none"
              />
              <div className="flex gap-1.5">
                <button
                  onClick={() => connect.mutate()}
                  disabled={connect.isPending || !storeId.trim()}
                  className="rounded-md bg-zinc-900 px-2 py-1 text-[10px] font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                >
                  {connect.isPending ? "Connecting…" : "Connect"}
                </button>
              </div>
            </div>
          ) : (
            <p className="text-[10px] text-zinc-500">
              Site {connection?.externalStoreId} · Brand{" "}
              {connection?.externalBrandId}
            </p>
          )}
        </div>

        {connected && (
          <button
            onClick={() => setManageOpen(true)}
            className="flex-shrink-0 rounded-md bg-zinc-900 px-3 py-1.5 text-[10px] font-medium text-white hover:bg-zinc-800"
          >
            Manage
          </button>
        )}
      </div>
      {connected && (
        <DeliverooManageModal
          connectionId={connection!.id as string}
          brandId={brandId}
          locationId={locationId}
          siteId={(connection?.externalStoreId as string) ?? null}
          deliverooBrandId={(connection?.externalBrandId as string) ?? null}
          open={manageOpen}
          onClose={() => setManageOpen(false)}
          onChanged={onChanged}
        />
      )}
    </li>
  );
}

function UberEatsRow({
  brandId,
  locationId,
  connection,
  onChanged,
}: {
  brandId: string;
  locationId: string;
  connection: BrandPlatformConnection | null;
  onChanged: () => void;
}) {
  const connected =
    connection?.status === "connected" || connection?.status === "suspended";
  // "pending" = the merchant authorised via OAuth (token stored) but no store
  // is linked yet — offer the store picker rather than re-running OAuth.
  const authorisedNoStore = connection?.status === "pending";
  const [stores, setStores] = useState<
    Array<{ storeId: string; name: string; address: string | null }>
  >([]);
  const [picking, setPicking] = useState(false);
  const [storePickerOpen, setStorePickerOpen] = useState(false);
  // All post-connect management (status, hours, holiday hours, disconnect)
  // lives in the Manage modal — keeps this card compact.
  const [manageOpen, setManageOpen] = useState(false);

  const err = (e: any) =>
    toast.error(
      e?.response?.data?.message ?? e?.message ?? "Uber Eats request failed",
    );

  // If the merchant has authorised but no store is linked yet, auto-load the
  // store list and show the picker (drives off connection status, not URL
  // params — the Locations page cleans those before this drawer mounts).
  useEffect(() => {
    if (authorisedNoStore && !picking && stores.length === 0) {
      listStores.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorisedNoStore]);

  const connect = useMutation({
    mutationFn: () =>
      apiClient
        .get(
          `/v1/integrations/ubereats/connect?brandId=${brandId}&locationId=${locationId}`,
        )
        .then((r) => r.data as { authorizeUrl: string }),
    onSuccess: (d) => {
      // Full-page redirect to Uber's authorization page.
      window.location.assign(d.authorizeUrl);
    },
    onError: err,
  });

  const listStores = useMutation({
    mutationFn: () =>
      apiClient
        .post(`/v1/integrations/ubereats/stores`, { brandId, locationId })
        .then((r) => r.data as typeof stores),
    onSuccess: (d) => {
      setStores(d);
      setPicking(true);
    },
    onError: err,
  });

  const link = useMutation({
    mutationFn: (storeId: string) =>
      apiClient.post(`/v1/integrations/ubereats/link-store`, {
        brandId,
        locationId,
        storeId,
      }),
    onSuccess: () => {
      toast.success("Uber Eats store connected");
      setPicking(false);
      onChanged();
    },
    onError: err,
  });

  return (
    <li className="rounded-md border border-zinc-200 px-3 py-2">
      <div className="flex items-start gap-3">
        <PlatformLogo platform="UBER_EATS" size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-zinc-900">Uber Eats</span>
            <StatusChip status={connection?.status ?? "not_connected"} />
          </div>

          {picking ? (
            <div className="mt-1.5 space-y-1">
              {listStores.isPending ? (
                <p className="text-[10px] text-zinc-500">Loading your stores…</p>
              ) : stores.length === 0 ? (
                <p className="text-[10px] text-amber-700">
                  No stores found in this Uber Eats account yet. If Uber is
                  still provisioning your test store, retry shortly.
                </p>
              ) : (
                // Opens the searchable modal rather than dumping every store
                // into this narrow column — accounts routinely hold 40+ sites
                // with near-identical names.
                <button
                  onClick={() => setStorePickerOpen(true)}
                  className="block w-full rounded-md border border-zinc-900 bg-zinc-900 px-2 py-1.5 text-[11px] font-semibold text-white hover:bg-zinc-800"
                >
                  Choose store to connect ({stores.length})
                </button>
              )}
              <button
                onClick={() => listStores.mutate()}
                disabled={listStores.isPending}
                className="text-[10px] text-zinc-500 hover:text-zinc-800 disabled:opacity-50"
              >
                Refresh stores
              </button>
              {storePickerOpen && (
                <StorePickerModal
                  title="Connect an Uber Eats store"
                  stores={stores}
                  busy={link.isPending}
                  onPick={(storeId) => {
                    setStorePickerOpen(false);
                    link.mutate(storeId);
                  }}
                  onClose={() => setStorePickerOpen(false)}
                  onRefresh={() => listStores.mutate()}
                />
              )}
            </div>
          ) : connected ? (
            <p className="text-[10px] text-zinc-500">
              Store {connection?.externalStoreId}
            </p>
          ) : authorisedNoStore ? (
            <p className="text-[10px] text-zinc-500">
              Authorised — choose your store to finish.
            </p>
          ) : (
            <p className="text-[10px] text-zinc-500">
              Connect opens Uber's sign-in to authorise your store.
            </p>
          )}
        </div>

        <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1">
          {connected ? (
            <button
              onClick={() => setManageOpen(true)}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-[10px] font-medium text-white hover:bg-zinc-800"
            >
              Manage
            </button>
          ) : authorisedNoStore && !picking ? (
            <button
              onClick={() => listStores.mutate()}
              disabled={listStores.isPending}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-[10px] font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              Choose store
            </button>
          ) : (
            !picking && (
              <button
                onClick={() => connect.mutate()}
                disabled={connect.isPending}
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-[10px] font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                {connect.isPending ? "Opening…" : "Connect"}
              </button>
            )
          )}
        </div>
      </div>
      {connected && (
        <UberEatsManageModal
          connectionId={connection!.id as string}
          storeId={(connection?.externalStoreId as string) ?? null}
          brandId={brandId}
          locationId={locationId}
          open={manageOpen}
          onClose={() => setManageOpen(false)}
          onChanged={onChanged}
        />
      )}
    </li>
  );
}

function StatusChip({ status }: { status: ConnectionStatus }) {
  const map: Record<ConnectionStatus, [string, string, string]> = {
    not_connected: ["bg-zinc-100", "text-zinc-500", "Not connected"],
    pending: ["bg-amber-50", "text-amber-700", "Pending"],
    connected: ["bg-emerald-50", "text-emerald-700", "Connected"],
    suspended: ["bg-orange-50", "text-orange-700", "Suspended"],
    error: ["bg-red-50", "text-red-700", "Error"],
  };
  const [bg, fg, label] = map[status];
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${bg} ${fg}`}>
      {label}
    </span>
  );
}
