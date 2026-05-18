"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Shield,
  Smartphone,
  Key,
  Globe,
  Monitor,
  Plus,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Copy,
  Eye,
  EyeOff,
  X,
  Lock,
  RefreshCw,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { cn } from "@/lib/utils";

type Tab = "mfa" | "sessions" | "ip-allowlist" | "audit";

interface MfaStatus { isEnabled: boolean; hasBackupCodes: boolean }
interface MfaSetup { secret: string; qrCodeUrl: string; backupCodes: string[] }
interface DeviceSession {
  id: string;
  deviceName: string | null;
  deviceType: string | null;
  ipAddress: string | null;
  lastSeenAt: string;
  expiresAt: string;
  createdAt: string;
}
interface IpRule { id: string; cidr: string; label: string | null; isActive: boolean }
interface AuditEntry {
  id: string;
  event: string;
  resource: string | null;
  resourceId: string | null;
  ipAddress: string | null;
  createdAt: string;
}

export default function SecurityPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("mfa");
  const [mfaSetup, setMfaSetup] = useState<MfaSetup | null>(null);
  const [mfaToken, setMfaToken] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [newCidr, setNewCidr] = useState("");
  const [newCidrLabel, setNewCidrLabel] = useState("");

  const { data: mfaStatus } = useQuery({
    queryKey: ["mfa-status"],
    queryFn: () => apiClient.get("/v1/security/mfa/status").then((r) => r.data as MfaStatus),
    enabled: tab === "mfa",
  });

  const { data: sessions } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => apiClient.get("/v1/security/sessions").then((r) => r.data as DeviceSession[]),
    enabled: tab === "sessions",
  });

  const { data: ipRules } = useQuery({
    queryKey: ["ip-allowlist"],
    queryFn: () => apiClient.get("/v1/security/ip-allowlist").then((r) => r.data as IpRule[]),
    enabled: tab === "ip-allowlist",
  });

  const { data: auditLog } = useQuery({
    queryKey: ["audit-log"],
    queryFn: () => apiClient.get("/v1/security/audit-log?limit=50").then((r) => r.data as { entries: AuditEntry[] }),
    enabled: tab === "audit",
  });

  const setupMfaMutation = useMutation({
    mutationFn: () => apiClient.post("/v1/security/mfa/setup").then((r) => r.data as MfaSetup),
    onSuccess: setMfaSetup,
  });

  const enableMfaMutation = useMutation({
    mutationFn: (token: string) => apiClient.post("/v1/security/mfa/verify", { token }).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["mfa-status"] }); setMfaSetup(null); setMfaToken(""); },
  });

  const disableMfaMutation = useMutation({
    mutationFn: () => apiClient.delete("/v1/security/mfa").then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mfa-status"] }),
  });

  const revokeSessionMutation = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/v1/security/sessions/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });

  const revokeAllMutation = useMutation({
    mutationFn: () => apiClient.delete("/v1/security/sessions").then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });

  const addIpMutation = useMutation({
    mutationFn: () => apiClient.post("/v1/security/ip-allowlist", { cidr: newCidr, label: newCidrLabel || null }).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["ip-allowlist"] }); setNewCidr(""); setNewCidrLabel(""); },
  });

  const toggleIpMutation = useMutation({
    mutationFn: (id: string) => apiClient.patch(`/v1/security/ip-allowlist/${id}/toggle`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ip-allowlist"] }),
  });

  const removeIpMutation = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/v1/security/ip-allowlist/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ip-allowlist"] }),
  });

  const TABS = [
    { key: "mfa",          label: "MFA",          icon: Smartphone },
    { key: "sessions",     label: "Sessions",      icon: Monitor },
    { key: "ip-allowlist", label: "IP Allowlist",  icon: Globe },
    { key: "audit",        label: "Audit Log",     icon: Key },
  ] as const;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-3">
        <Shield className="w-6 h-6 text-zinc-700" />
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Security</h1>
          <p className="text-sm text-zinc-500 mt-0.5">MFA, sessions, IP allowlist, and audit trail</p>
        </div>
      </div>

      <div className="flex gap-1 p-1 bg-zinc-100 rounded-xl w-fit">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setTab(key as Tab)}
            className={cn("flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
              tab === key ? "bg-white shadow-sm text-zinc-900" : "text-zinc-500 hover:text-zinc-700")}>
            <Icon className="w-4 h-4" />{label}
          </button>
        ))}
      </div>

      {/* MFA */}
      {tab === "mfa" && (
        <div className="bg-white border border-zinc-200 rounded-2xl p-6 space-y-5">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 font-medium text-zinc-900">
                <Lock className="w-4 h-4 text-zinc-500" />
                Two-factor authentication
              </div>
              <p className="text-sm text-zinc-500 mt-1">
                Use an authenticator app (Google Authenticator, Authy) for an extra layer of security.
              </p>
            </div>
            {mfaStatus?.isEnabled ? (
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 bg-emerald-100 px-2 py-1 rounded-full">
                  <CheckCircle2 className="w-3 h-3" /> Enabled
                </span>
                <button onClick={() => { if (confirm("Disable MFA?")) disableMfaMutation.mutate(); }}
                  disabled={disableMfaMutation.isPending}
                  className="text-xs text-zinc-500 hover:text-red-600 underline">
                  Disable
                </button>
              </div>
            ) : (
              <button onClick={() => setupMfaMutation.mutate()} disabled={setupMfaMutation.isPending}
                className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {setupMfaMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
                Set up MFA
              </button>
            )}
          </div>

          {mfaSetup && (
            <div className="border border-zinc-200 rounded-xl p-5 space-y-4 bg-zinc-50">
              <div className="text-sm font-medium text-zinc-900">Scan this QR code with your authenticator app</div>
              <div className="bg-white border border-zinc-200 rounded-lg p-4 text-center">
                <div className="text-xs text-zinc-500 mb-2">Or enter this secret manually:</div>
                <div className="flex items-center justify-center gap-2">
                  <code className={cn("text-sm font-mono bg-zinc-100 px-3 py-1 rounded", !showSecret && "blur-sm select-none")}>
                    {mfaSetup.secret}
                  </code>
                  <button onClick={() => setShowSecret((v) => !v)} className="text-zinc-400 hover:text-zinc-700">
                    {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                  <button onClick={() => navigator.clipboard.writeText(mfaSetup.secret)} className="text-zinc-400 hover:text-zinc-700">
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div>
                <div className="text-sm font-medium text-zinc-900 mb-2">Enter the 6-digit code to verify</div>
                <div className="flex gap-3">
                  <input value={mfaToken} onChange={(e) => setMfaToken(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="000000" maxLength={6}
                    className="w-32 border border-zinc-200 rounded-lg px-3 py-2 text-lg font-mono text-center focus:outline-none focus:ring-2 focus:ring-orange-500 tracking-widest" />
                  <button onClick={() => enableMfaMutation.mutate(mfaToken)} disabled={mfaToken.length < 6 || enableMfaMutation.isPending}
                    className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 flex items-center gap-2">
                    {enableMfaMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Verify & enable
                  </button>
                  <button onClick={() => setMfaSetup(null)} className="px-4 py-2 border border-zinc-200 rounded-lg text-sm font-medium">Cancel</button>
                </div>
              </div>
              {mfaSetup.backupCodes?.length > 0 && (
                <div className="border border-amber-200 bg-amber-50 rounded-lg p-4">
                  <div className="text-sm font-medium text-zinc-900 mb-2 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    Save these backup codes
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {mfaSetup.backupCodes.map((c) => (
                      <code key={c} className="text-xs font-mono text-zinc-700">{c}</code>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* SESSIONS */}
      {tab === "sessions" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-zinc-500">Active login sessions across all devices.</p>
            <button onClick={() => { if (confirm("Revoke all other sessions?")) revokeAllMutation.mutate(); }}
              disabled={revokeAllMutation.isPending}
              className="flex items-center gap-2 text-sm text-red-600 hover:text-red-700 font-medium">
              <RefreshCw className="w-3.5 h-3.5" /> Revoke all others
            </button>
          </div>
          {!sessions?.length ? (
            <div className="text-center py-10 text-zinc-500">No active sessions.</div>
          ) : (
            <div className="space-y-2">
              {sessions.map((s) => (
                <div key={s.id} className="bg-white border border-zinc-200 rounded-xl px-5 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Monitor className="w-5 h-5 text-zinc-400 flex-shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-zinc-900">{s.deviceName ?? s.deviceType ?? "Unknown device"}</div>
                      <div className="text-xs text-zinc-500 mt-0.5">
                        {s.ipAddress && <span className="mr-3">{s.ipAddress}</span>}
                        Last seen {new Date(s.lastSeenAt).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <button onClick={() => revokeSessionMutation.mutate(s.id)} disabled={revokeSessionMutation.isPending}
                    className="p-1.5 rounded-lg text-zinc-400 hover:text-red-600 hover:bg-red-50 transition-colors">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* IP ALLOWLIST */}
      {tab === "ip-allowlist" && (
        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-700">
              When rules are active, only IPs matching a rule can access your account. Ensure your own IP is always included.
            </div>
          </div>

          <div className="flex gap-3">
            <input value={newCidr} onChange={(e) => setNewCidr(e.target.value)} placeholder="1.2.3.4/32 or 192.168.0.0/24"
              className="flex-1 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 font-mono" />
            <input value={newCidrLabel} onChange={(e) => setNewCidrLabel(e.target.value)} placeholder="Label (optional)"
              className="w-40 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500" />
            <button onClick={() => addIpMutation.mutate()} disabled={addIpMutation.isPending || !newCidr}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-lg text-sm font-medium disabled:opacity-50">
              <Plus className="w-4 h-4" /> Add
            </button>
          </div>

          {!ipRules?.length ? (
            <div className="text-center py-10 text-zinc-500">No IP rules. All IPs are allowed.</div>
          ) : (
            <div className="space-y-2">
              {ipRules.map((rule) => (
                <div key={rule.id} className="bg-white border border-zinc-200 rounded-xl px-5 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Globe className={cn("w-4 h-4", rule.isActive ? "text-emerald-500" : "text-zinc-300")} />
                    <div>
                      <code className="text-sm font-mono text-zinc-900">{rule.cidr}</code>
                      {rule.label && <span className="text-xs text-zinc-500 ml-2">{rule.label}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => toggleIpMutation.mutate(rule.id)}
                      className={cn("text-xs px-2 py-1 rounded-full font-medium border transition-colors",
                        rule.isActive ? "border-emerald-200 text-emerald-700 bg-emerald-50" : "border-zinc-200 text-zinc-500")}>
                      {rule.isActive ? "Active" : "Disabled"}
                    </button>
                    <button onClick={() => removeIpMutation.mutate(rule.id)}
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-red-600 hover:bg-red-50">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* AUDIT LOG */}
      {tab === "audit" && (
        <div className="bg-white border border-zinc-200 rounded-2xl overflow-hidden">
          {!auditLog?.entries?.length ? (
            <div className="text-center py-10 text-zinc-500">No audit events.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100">
                  {["Event", "Resource", "IP", "Time"].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {auditLog.entries.map((e) => (
                  <tr key={e.id} className="border-b border-zinc-50 last:border-0 hover:bg-zinc-50">
                    <td className="px-4 py-3 font-medium text-zinc-900">{e.event}</td>
                    <td className="px-4 py-3 text-zinc-500 text-xs">
                      {e.resource && <span>{e.resource}</span>}
                      {e.resourceId && <span className="ml-1 font-mono text-zinc-400">{e.resourceId.slice(0, 8)}</span>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-500">{e.ipAddress ?? "—"}</td>
                    <td className="px-4 py-3 text-xs text-zinc-500">{new Date(e.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
