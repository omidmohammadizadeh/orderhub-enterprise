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
import { visibleChannelIds } from "@orderhub/shared";
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
import { UberEatsManageModal } from "@/components/locations/ubereats-manage-modal";
import { DeliverooManageModal } from "@/components/locations/deliveroo-manage-modal";
import { JustEatManageModal } from "@/components/locations/justeat-manage-modal";
import { deliverooClient } from "@/lib/api/deliveroo.client";
import { justEatClient } from "@/lib/api/justeat.client";
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

interface Props {
  brand: Brand;
  locationId: string;
  /**
   * The SHOP's country. Channels derive from it, so a UK shop is never shown
   * Careem and a Dubai shop is never shown Just Eat — every channel here needs
   * credentials and a store id, so an unavailable one is not harmless clutter,
   * it is an invitation to configure something that cannot work.
   *
   * Deliberately not a control in the header: that would be a second source of
   * truth able to disagree with the location switcher. A shop is in exactly one
   * country, so ask the shop.
   */
  country?: string | null;
}

export function BrandPlatformGrid({ brand, locationId, country }: Props) {
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

  // Country decides the list; anything already connected is added back even if
  // this country would not offer it. Hiding a live connection would not stop
  // the orders — it would only remove the screen that can turn them off.
  const PLATFORMS = visibleChannelIds(
    country,
    conns
      .filter((c) => c.locationId === locationId && c.status !== "not_connected")
      .map((c) => c.platform as string),
  ) as PlatformId[];

  const upsert = useMutation({
    mutationFn: brandConnectionsClient.upsert,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["brand-connections", brandId] }),
  });
  const disconnect = useMutation({
    mutationFn: brandConnectionsClient.disconnect,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["brand-connections", brandId] }),
  });

  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which channel's settings are open. Null = none, so the page opens as a
  // clean grid instead of six expanded forms.
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformId | null>(
    null,
  );

  // Tile status. DIRECT_ONLINE's connected-ness lives on the Brand row
  // itself (directOrderingEnabled + onlineOrderingSlug), not on a
  // BrandPlatformConnection — same rule the panel below uses.
  const statusFor = (platform: PlatformId): ConnectionStatus => {
    if (platform === "DIRECT_ONLINE") {
      return currentBrand.directOrderingEnabled && currentBrand.onlineOrderingSlug
        ? "connected"
        : "not_connected";
    }
    return conns.find((c) => c.platform === platform)?.status ?? "not_connected";
  };


  // Each channel's settings panel. Lifted out of the old list so the tiles
  // above can decide WHEN to show one, without changing WHAT any of these
  // rows render — the connect flows are untouched.
  const renderPanel = (platform: PlatformId) => {
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
          // Just Eat (JET Connect) is a real API connection too, but there is
          // no OAuth and no id to resolve: the operator types in what their
          // Just Eat onboarding email gave them.
          if (platform === "JUST_EAT") {
            return (
              <JustEatRow
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
  };

  return (
    <>
      {/* Channels as tiles rather than full-width strips: six stacked rows
          made a page of near-identical bars where the only thing that
          differed was a logo and a chip. A tile grid is scannable — the
          operator is looking for one channel, not reading a list. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2.5">
        {PLATFORMS.map((platform) => (
          <ChannelTile
            key={platform}
            platform={platform}
            status={statusFor(platform)}
            selected={selectedPlatform === platform}
            onClick={() =>
              setSelectedPlatform((cur) => (cur === platform ? null : platform))
            }
          />
        ))}
      </div>

      {/* The selected channel's settings, rendered by the SAME row component
          the list used. Collapsed by default so the grid stays scannable. */}
      {selectedPlatform && (
        <ul className="mt-3">{renderPanel(selectedPlatform)}</ul>
      )}


      <BrandSettingsDrawer
        brand={currentBrand}
        locationId={locationId}
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

// A single channel tile. Square, logo-led and status-chipped — enough to
// answer "is this one live?" at a glance, with the real settings a click away
// in the panel below rather than crammed inside the tile.
function ChannelTile({
  platform,
  status,
  selected,
  onClick,
}: {
  platform: PlatformId;
  status: ConnectionStatus;
  selected: boolean;
  onClick: () => void;
}) {
  const live = status === "connected";
  const bad = status === "error" || status === "suspended";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={
        "flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border p-3 text-center transition-all " +
        (selected
          ? "border-zinc-900 bg-white ring-2 ring-zinc-900/10"
          : "border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-sm")
      }
    >
      <PlatformLogo platform={platform} size={40} />
      <span className="line-clamp-2 text-xs font-semibold leading-tight text-zinc-900">
        {platformLabel(platform)}
      </span>
      <span
        className={
          "rounded-full px-2 py-0.5 text-[10px] font-semibold " +
          (live
            ? "bg-emerald-50 text-emerald-700"
            : bad
              ? "bg-red-50 text-red-700"
              : status === "pending"
                ? "bg-amber-50 text-amber-700"
                : "bg-zinc-100 text-zinc-500")
        }
      >
        {live
          ? "Connected"
          : bad
            ? status === "error"
              ? "Error"
              : "Suspended"
            : status === "pending"
              ? "Pending"
              : "Not connected"}
      </span>
    </button>
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

  // Careem has no external store ID to enter, and asking for one sends the
  // operator looking for a value that does not exist.
  //
  // Uber and Deliveroo each mint an identifier on their side which we store
  // and send back. Careem inverts that: their POS API 2.1.0 registers a brand
  // as POST /brands {id: <our brand id>} and a branch as
  // PUT /branches/{our location id}. Our ids ARE their ids — there is no
  // mapping table and nothing to paste. Careem then moves the record from
  // UNMAPPED to MAPPED on their side.
  //
  // So this row points at the Careem page, which runs that registration,
  // rather than offering a text box that can only ever be wrong.
  const isCareem = platform === "CAREEM";

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
          {isCareem ? (
            <p className="text-[10px] text-zinc-500">
              Careem uses this brand and location&apos;s own IDs — there is no
              store ID to enter. Register them from the Careem page.
            </p>
          ) : (
            connection?.externalStoreId &&
            !editing && (
              <p className="text-[10px] text-zinc-500">
                Store ID: {connection.externalStoreId}
              </p>
            )
          )}
        </div>
        {isCareem ? (
          <a
            href="/dashboard/integrations/careem"
            className="rounded-md border border-zinc-300 px-2 py-1 text-[10px] font-medium hover:bg-zinc-50"
          >
            Set up on the Careem page
          </a>
        ) : editing ? (
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

function JustEatRow({
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
  const [manageOpen, setManageOpen] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [restaurantId, setRestaurantId] = useState("");
  const [menuKey, setMenuKey] = useState("");
  const [orderKey, setOrderKey] = useState("");

  // The connection row carries the POS location id; the Restaurant ID lives in
  // metadata, so it is read back from the JET endpoint rather than guessed.
  const details = useQuery({
    queryKey: ["jet-connection", connection?.id],
    queryFn: () => justEatClient.health(connection!.id as string),
    enabled: !!connection?.id && connected,
  });

  useEffect(() => {
    if (!connected) setRestaurantId("");
  }, [connected]);

  const connect = useMutation({
    mutationFn: () =>
      justEatClient.connect({
        brandId,
        locationId,
        restaurantReference: restaurantId.trim(),
        menuKey: menuKey.trim() || undefined,
        orderKey: orderKey.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success("Just Eat restaurant connected");
      setMenuKey("");
      setOrderKey("");
      onChanged();
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ?? e?.message ?? "Just Eat request failed",
      ),
  });

  return (
    <li className="rounded-md border border-zinc-200 px-3 py-2">
      <div className="flex items-start gap-3">
        <PlatformLogo platform="JUST_EAT" size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-zinc-900">Just Eat</span>
            <StatusChip status={connection?.status ?? "not_connected"} />
          </div>

          {!connected ? (
            <div className="mt-1.5 space-y-1.5">
              <input
                value={restaurantId}
                onChange={(e) => setRestaurantId(e.target.value)}
                placeholder="Restaurant ID (from Just Eat)"
                className="w-full rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-zinc-900 focus:outline-none"
              />
              {/* Keys are the exception, not the rule: only brands over six
                  locations get their own. Hiding them behind a toggle keeps
                  the common case a single field, the way Just Eat's own
                  bridge does it. */}
              {showKeys ? (
                <>
                  <input
                    type="password"
                    value={menuKey}
                    onChange={(e) => setMenuKey(e.target.value)}
                    placeholder="Menu API key (optional)"
                    className="w-full rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-zinc-900 focus:outline-none"
                  />
                  <input
                    type="password"
                    value={orderKey}
                    onChange={(e) => setOrderKey(e.target.value)}
                    placeholder="Order API key (optional)"
                    className="w-full rounded-md border border-zinc-200 px-2 py-1 text-xs focus:border-zinc-900 focus:outline-none"
                  />
                </>
              ) : (
                <button
                  onClick={() => setShowKeys(true)}
                  className="text-[10px] text-zinc-500 underline hover:text-zinc-800"
                >
                  This brand has its own API keys
                </button>
              )}
              <div className="flex gap-1.5">
                <button
                  onClick={() => connect.mutate()}
                  disabled={connect.isPending || !restaurantId.trim()}
                  className="rounded-md bg-zinc-900 px-2 py-1 text-[10px] font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                >
                  {connect.isPending ? "Connecting…" : "Connect"}
                </button>
              </div>
              <p className="text-[10px] text-zinc-400">
                Just Eat sends the Restaurant ID once your integration is
                approved. API keys are optional — leave them empty to use the
                shared country keys.
              </p>
            </div>
          ) : (
            <p className="text-[10px] text-zinc-500">
              Restaurant {details.data?.restaurantReference ?? "—"}
              {details.data?.hasBrandKeys ? " · own API keys" : ""}
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
        <JustEatManageModal
          connectionId={connection!.id as string}
          brandId={brandId}
          locationId={locationId}
          restaurantReference={details.data?.restaurantReference ?? null}
          posLocationId={
            details.data?.posLocationId ??
            (connection?.externalStoreId as string) ??
            null
          }
          open={manageOpen}
          onClose={() => setManageOpen(false)}
          onChanged={() => {
            details.refetch();
            onChanged();
          }}
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
