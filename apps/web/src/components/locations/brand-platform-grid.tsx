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
import { Loader2, Pencil, Trash2 } from "lucide-react";
import {
  brandConnectionsClient,
  type BrandPlatformConnection,
  type ConnectionStatus,
  type PlatformId,
} from "@/lib/api/locations.client";
import { PlatformLogo, platformLabel } from "@/components/ui/platform-logo";

const PLATFORMS: PlatformId[] = [
  "JUST_EAT",
  "UBER_EATS",
  "DELIVEROO",
  "HUBRISE",
  "STUART",
  "UBER_DIRECT",
];

interface Props {
  brandId: string;
  locationId: string;
}

export function BrandPlatformGrid({ brandId, locationId }: Props) {
  const qc = useQueryClient();
  const connsQuery = useQuery({
    queryKey: ["brand-connections", brandId],
    queryFn: () => brandConnectionsClient.listForBrand(brandId),
  });

  const conns = connsQuery.data ?? [];

  const upsert = useMutation({
    mutationFn: brandConnectionsClient.upsert,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["brand-connections", brandId] }),
  });
  const disconnect = useMutation({
    mutationFn: brandConnectionsClient.disconnect,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["brand-connections", brandId] }),
  });

  return (
    <ul className="space-y-1.5">
      {PLATFORMS.map((platform) => {
        const conn = conns.find((c) => c.platform === platform);
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
        <PlatformLogo platform={platform} size={28} />
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
