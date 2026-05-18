"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plug2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  AlertTriangle,
  ExternalLink,
  Clock,
  Activity,
  X,
  Eye,
  EyeOff,
  Loader2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { useAuthStore } from "@/stores/auth.store";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Integration {
  id: string;
  locationId: string;
  platform: string;
  status: "ACTIVE" | "INACTIVE" | "ERROR" | "PENDING_SETUP";
  webhookUrl?: string | null;
  lastSyncAt?: string | null;
  lastErrorAt?: string | null;
  lastError?: string | null;
}

const PLATFORM_META: Record<string, { name: string; description: string; color: string; fields: Array<{ key: string; label: string; secret?: boolean; placeholder?: string }> }> = {
  UBER_EATS: {
    name: "Uber Eats",
    description: "Receive and manage Uber Eats orders in real time via webhook.",
    color: "from-[#06C167] to-[#05A855]",
    fields: [
      { key: "storeId", label: "Store ID", placeholder: "abc123-def456..." },
      { key: "clientId", label: "Client ID", placeholder: "your-client-id" },
      { key: "clientSecret", label: "Client Secret", secret: true, placeholder: "your-client-secret" },
    ],
  },
  DELIVEROO: {
    name: "Deliveroo",
    description: "Sync orders and menu updates with your Deliveroo restaurant.",
    color: "from-teal-500 to-teal-700",
    fields: [
      { key: "restaurantId", label: "Restaurant ID", placeholder: "rest_..." },
      { key: "apiKey", label: "API Key", secret: true, placeholder: "dlv_..." },
    ],
  },
  JUST_EAT: {
    name: "Just Eat",
    description: "Integrate with Just Eat Takeaway for seamless order flow.",
    color: "from-orange-400 to-orange-600",
    fields: [
      { key: "restaurantReference", label: "Restaurant Reference", placeholder: "JE-1234" },
      { key: "apiKey", label: "API Key", secret: true, placeholder: "je_..." },
    ],
  },
  HUBRISE: {
    name: "HubRise",
    description: "Connect via HubRise middleware — enables multiple platforms at once.",
    color: "from-violet-500 to-violet-700",
    fields: [
      { key: "accessToken", label: "Access Token", secret: true, placeholder: "hubrise_..." },
      { key: "locationId", label: "HubRise Location ID", placeholder: "abc-1" },
    ],
  },
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function IntegrationsPage() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string>("");

  // In a real app this would come from a locations selector; for now use URL param or first location
  const activeLocationId = locationId || ((user as any)?.defaultLocationId ?? "");

  const { data: integrations = [], isLoading } = useQuery<Integration[]>({
    queryKey: ["integrations", activeLocationId],
    queryFn: () =>
      apiClient.get(`/v1/integrations?locationId=${activeLocationId}`).then((r) => r.data),
    enabled: !!activeLocationId,
    refetchInterval: 30_000,
  });

  const retrySyncMutation = useMutation({
    mutationFn: (integrationId: string) =>
      apiClient.post(`/v1/integrations/${integrationId}/retry`, {}).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations", activeLocationId] }),
  });

  const disconnectMutation = useMutation({
    mutationFn: (integrationId: string) =>
      apiClient.patch(`/v1/integrations/${integrationId}`, { status: "INACTIVE" }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations", activeLocationId] }),
  });

  const integratedPlatforms = new Set(integrations.map((i) => i.platform));
  const platforms = Object.keys(PLATFORM_META);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Integrations</h1>
          <p className="text-sm text-zinc-500">Connect delivery platforms and third-party services.</p>
        </div>
      </div>

      {/* Connected integrations */}
      {integrations.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-3">Connected</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {integrations.map((integration) => {
              const meta = PLATFORM_META[integration.platform];
              if (!meta) return null;
              return (
                <IntegrationCard
                  key={integration.id}
                  integration={integration}
                  meta={meta}
                  onRetry={() => retrySyncMutation.mutate(integration.id)}
                  onDisconnect={() => disconnectMutation.mutate(integration.id)}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Available platforms */}
      <div>
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-3">
          {integrations.length > 0 ? "Available to connect" : "Platforms"}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {platforms
            .filter((p) => !integratedPlatforms.has(p))
            .map((platform) => {
              const meta = PLATFORM_META[platform];
              return (
                <ConnectCard
                  key={platform}
                  platform={platform}
                  meta={meta}
                  locationId={activeLocationId}
                  isConfiguring={configuring === platform}
                  onStartConfigure={() => setConfiguring(platform)}
                  onDone={() => {
                    setConfiguring(null);
                    qc.invalidateQueries({ queryKey: ["integrations", activeLocationId] });
                  }}
                />
              );
            })}
        </div>
      </div>

      {/* No location selected */}
      {!activeLocationId && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Plug2 className="h-10 w-10 text-zinc-300 mb-3" />
          <p className="font-medium text-zinc-500">Select a location to manage integrations</p>
          <div className="mt-4 max-w-xs w-full">
            <Input
              placeholder="Paste location ID"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="h-9 text-sm text-center"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Connected integration card ────────────────────────────────────────────────

function IntegrationCard({
  integration,
  meta,
  onRetry,
  onDisconnect,
}: {
  integration: Integration;
  meta: typeof PLATFORM_META[string];
  onRetry: () => void;
  onDisconnect: () => void;
}) {
  const [showError, setShowError] = useState(false);

  return (
    <Card className="overflow-hidden">
      <div className={`h-1 w-full bg-gradient-to-r ${meta.color}`} />
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-zinc-900">{meta.name}</p>
              <StatusBadge status={integration.status} />
            </div>
            {integration.lastSyncAt && (
              <p className="text-xs text-zinc-400 mt-1 flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Synced {new Date(integration.lastSyncAt).toLocaleTimeString()}
              </p>
            )}
            {integration.lastError && (
              <button
                onClick={() => setShowError((p) => !p)}
                className="text-xs text-red-500 mt-1 flex items-center gap-1 hover:underline"
              >
                <AlertTriangle className="h-3 w-3" />
                {showError ? "Hide error" : "Show last error"}
              </button>
            )}
            {showError && integration.lastError && (
              <p className="text-xs text-red-500 mt-1 font-mono bg-red-50 rounded p-2 break-all">
                {integration.lastError}
              </p>
            )}
          </div>
          <div className="flex gap-1.5 flex-shrink-0">
            {integration.status === "ERROR" && (
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs gap-1" onClick={onRetry}>
                <RefreshCw className="h-3 w-3" /> Retry
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-zinc-400 hover:text-red-500"
              onClick={onDisconnect}
            >
              Disconnect
            </Button>
          </div>
        </div>

        {integration.webhookUrl && (
          <div className="mt-3 pt-3 border-t border-zinc-100">
            <p className="text-[10px] text-zinc-400 mb-1">Webhook URL</p>
            <div className="flex items-center gap-1.5">
              <code className="text-[10px] text-zinc-600 bg-zinc-100 rounded px-2 py-1 flex-1 truncate">
                {integration.webhookUrl}
              </code>
              <button
                onClick={() => navigator.clipboard.writeText(integration.webhookUrl!)}
                className="text-zinc-400 hover:text-zinc-600 text-[10px]"
              >
                Copy
              </button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Connect card (not yet configured) ────────────────────────────────────────

function ConnectCard({
  platform,
  meta,
  locationId,
  isConfiguring,
  onStartConfigure,
  onDone,
}: {
  platform: string;
  meta: typeof PLATFORM_META[string];
  locationId: string;
  isConfiguring: boolean;
  onStartConfigure: () => void;
  onDone: () => void;
}) {
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const qc = useQueryClient();

  const connectMutation = useMutation({
    mutationFn: () =>
      apiClient
        .post(`/v1/integrations`, {
          locationId,
          platform,
          credentials,
          settings: {},
        })
        .then((r) => r.data),
    onSuccess: onDone,
  });

  if (!isConfiguring) {
    return (
      <Card className="overflow-hidden">
        <div className={`h-1 w-full bg-gradient-to-r ${meta.color} opacity-30`} />
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-zinc-900">{meta.name}</p>
              <p className="text-xs text-zinc-400 mt-0.5 line-clamp-2">{meta.description}</p>
            </div>
            <StatusBadge status="INACTIVE" />
          </div>
          <div className="mt-4">
            <Button
              size="sm"
              onClick={onStartConfigure}
              disabled={!locationId}
              className="bg-orange-500 hover:bg-orange-600 text-white gap-1.5"
            >
              <Plug2 className="h-3.5 w-3.5" />
              Connect
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden sm:col-span-2">
      <div className={`h-1 w-full bg-gradient-to-r ${meta.color}`} />
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-4">
          <p className="font-semibold text-zinc-900">Connect {meta.name}</p>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setCredentials({})}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {meta.fields.map((field) => (
            <div key={field.key}>
              <Label className="text-xs text-zinc-500 mb-1">{field.label}</Label>
              <div className="relative">
                <Input
                  type={field.secret && !showSecrets[field.key] ? "password" : "text"}
                  placeholder={field.placeholder}
                  value={credentials[field.key] ?? ""}
                  onChange={(e) => setCredentials((p) => ({ ...p, [field.key]: e.target.value }))}
                  className="h-9 text-sm pr-8"
                />
                {field.secret && (
                  <button
                    type="button"
                    onClick={() => setShowSecrets((p) => ({ ...p, [field.key]: !p[field.key] }))}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
                  >
                    {showSecrets[field.key] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        {connectMutation.isError && (
          <p className="text-xs text-red-600 mt-3">Failed to connect. Check your credentials and try again.</p>
        )}
        <div className="flex gap-2 mt-4">
          <Button
            size="sm"
            onClick={() => connectMutation.mutate()}
            disabled={connectMutation.isPending || !locationId}
            className="bg-orange-500 hover:bg-orange-600 text-white"
          >
            {connectMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
            Save & connect
          </Button>
          <Button size="sm" variant="outline" onClick={() => { setCredentials({}); onDone(); }}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: Integration["status"] | "INACTIVE" }) {
  const cfg = {
    ACTIVE: { label: "Active", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    INACTIVE: { label: "Disconnected", cls: "bg-zinc-100 text-zinc-500 border-zinc-200" },
    ERROR: { label: "Error", cls: "bg-red-50 text-red-600 border-red-200" },
    PENDING_SETUP: { label: "Setup required", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  }[status] ?? { label: status, cls: "bg-zinc-100 text-zinc-500 border-zinc-200" };

  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold border flex-shrink-0", cfg.cls)}>
      {status === "ACTIVE" && <CheckCircle2 className="h-2.5 w-2.5 mr-1" />}
      {status === "ERROR" && <AlertTriangle className="h-2.5 w-2.5 mr-1" />}
      {cfg.label}
    </span>
  );
}
