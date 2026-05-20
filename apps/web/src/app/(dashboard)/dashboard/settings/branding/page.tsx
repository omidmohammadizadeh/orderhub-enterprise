"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Palette,
  Globe,
  Mail,
  Image,
  Plus,
  Trash2,
  Loader2,
  CheckCircle2,
  Clock,
  XCircle,
  ExternalLink,
  AlertCircle,
} from "lucide-react";
import { apiClient } from "@/lib/api/client";
import { cn } from "@/lib/utils";

interface Branding {
  id: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  fontFamily: string;
  appName: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  emailFromName: string | null;
  emailFromAddr: string | null;
  emailFooterHtml: string | null;
  senderSmsName: string | null;
  customDomains: CustomDomain[];
}

interface CustomDomain {
  id: string;
  domain: string;
  status: "PENDING" | "VERIFYING" | "VERIFIED" | "ACTIVE" | "FAILED";
  txtRecord: string | null;
  verifiedAt: string | null;
}

const DOMAIN_STATUS: Record<string, { label: string; icon: React.ElementType; className: string }> = {
  PENDING:   { label: "Pending",   icon: Clock,         className: "text-amber-700 bg-amber-100" },
  VERIFYING: { label: "Verifying", icon: Loader2,       className: "text-blue-700 bg-blue-100" },
  VERIFIED:  { label: "Verified",  icon: CheckCircle2,  className: "text-emerald-700 bg-emerald-100" },
  ACTIVE:    { label: "Active",    icon: CheckCircle2,  className: "text-emerald-700 bg-emerald-100" },
  FAILED:    { label: "Failed",    icon: XCircle,       className: "text-red-700 bg-red-100" },
};

const FONTS = ["Inter", "Poppins", "DM Sans", "Plus Jakarta Sans", "Outfit", "Nunito"];

export default function BrandingPage() {
  const qc = useQueryClient();
  const [newDomain, setNewDomain] = useState("");
  const [form, setForm] = useState<Partial<Branding>>({});
  const [hasChanges, setHasChanges] = useState(false);

  const { data: branding, isLoading } = useQuery({
    queryKey: ["branding"],
    queryFn: () => apiClient.get("/v1/branding").then((r) => r.data as Branding).catch(() => null),
  });

  useEffect(() => {
    if (branding) {
      setForm({
        primaryColor:    branding.primaryColor,
        secondaryColor:  branding.secondaryColor,
        accentColor:     branding.accentColor,
        fontFamily:      branding.fontFamily,
        appName:         branding.appName ?? "",
        metaTitle:       branding.metaTitle ?? "",
        metaDescription: branding.metaDescription ?? "",
        emailFromName:   branding.emailFromName ?? "",
        emailFromAddr:   branding.emailFromAddr ?? "",
        emailFooterHtml: branding.emailFooterHtml ?? "",
        senderSmsName:   branding.senderSmsName ?? "",
      });
    }
  }, [branding]);

  const saveMutation = useMutation({
    mutationFn: () => apiClient.put("/v1/branding", form).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["branding"] }); setHasChanges(false); },
  });

  const addDomainMutation = useMutation({
    mutationFn: () => apiClient.post("/v1/branding/domains", { domain: newDomain }).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["branding"] }); setNewDomain(""); },
  });

  const verifyDomainMutation = useMutation({
    mutationFn: (id: string) => apiClient.post(`/v1/branding/domains/${id}/verify`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["branding"] }),
  });

  const removeDomainMutation = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/v1/branding/domains/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["branding"] }),
  });

  const updateForm = (key: keyof typeof form, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setHasChanges(true);
  };

  if (isLoading) {
    return <div className="flex items-center justify-center py-24"><Loader2 className="w-5 h-5 animate-spin text-zinc-400" /></div>;
  }

  return (
    <div className="space-y-8 max-w-3xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">White-label Branding</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Customise your ordering app, emails, and storefront</p>
        </div>
        {hasChanges && (
          <button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-lg text-sm font-medium disabled:opacity-50">
            {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            Save changes
          </button>
        )}
      </div>

      {/* Brand identity */}
      <section className="bg-white border border-zinc-200 rounded-2xl p-6 space-y-5">
        <div className="flex items-center gap-2 mb-1">
          <Palette className="w-4 h-4 text-zinc-500" />
          <h2 className="font-medium text-zinc-900">Brand Identity</h2>
        </div>

        <div className="grid grid-cols-2 gap-5">
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">App / store name</label>
            <input value={form.appName ?? ""} onChange={(e) => updateForm("appName", e.target.value)}
              placeholder="My Restaurant" className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">Font family</label>
            <select value={form.fontFamily ?? "Inter"} onChange={(e) => updateForm("fontFamily", e.target.value)}
              className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500">
              {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          {[
            { key: "primaryColor",   label: "Primary colour" },
            { key: "secondaryColor", label: "Secondary colour" },
            { key: "accentColor",    label: "Accent colour" },
          ].map(({ key, label }) => (
            <div key={key}>
              <label className="block text-xs font-medium text-zinc-600 mb-1">{label}</label>
              <div className="flex items-center gap-2 border border-zinc-200 rounded-lg px-3 py-2">
                <input type="color" value={(form[key as keyof typeof form] as string | undefined) ?? "#f97316"}
                  onChange={(e) => updateForm(key as keyof typeof form, e.target.value)}
                  className="w-6 h-6 rounded cursor-pointer border-0 p-0 bg-transparent" />
                <input value={(form[key as keyof typeof form] as string | undefined) ?? ""} onChange={(e) => updateForm(key as keyof typeof form, e.target.value)}
                  className="flex-1 text-sm font-mono focus:outline-none" />
              </div>
            </div>
          ))}
        </div>

        {/* Live preview */}
        <div className="border border-zinc-100 rounded-xl p-4 bg-zinc-50">
          <div className="text-xs text-zinc-400 mb-3 uppercase tracking-wide font-semibold">Preview</div>
          <div className="flex items-center gap-3">
            <button style={{ backgroundColor: form.primaryColor ?? "#f97316" }}
              className="px-4 py-2 text-white text-sm font-medium rounded-lg">
              Order now
            </button>
            <button style={{ backgroundColor: form.secondaryColor ?? "#1a1a2e", color: "white" }}
              className="px-4 py-2 text-sm font-medium rounded-lg">
              View menu
            </button>
            <div style={{ color: form.accentColor ?? "#fb923c" }} className="text-sm font-medium">
              {form.appName || "Your Restaurant"}
            </div>
          </div>
        </div>
      </section>

      {/* SEO */}
      <section className="bg-white border border-zinc-200 rounded-2xl p-6 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Globe className="w-4 h-4 text-zinc-500" />
          <h2 className="font-medium text-zinc-900">SEO & Meta</h2>
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-600 mb-1">Page title</label>
          <input value={form.metaTitle ?? ""} onChange={(e) => updateForm("metaTitle", e.target.value)}
            placeholder="Order from My Restaurant" className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-600 mb-1">Meta description</label>
          <textarea value={form.metaDescription ?? ""} onChange={(e) => updateForm("metaDescription", e.target.value)} rows={2}
            placeholder="Fresh, delicious food delivered to your door." className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 resize-none" />
        </div>
      </section>

      {/* Email & SMS */}
      <section className="bg-white border border-zinc-200 rounded-2xl p-6 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Mail className="w-4 h-4 text-zinc-500" />
          <h2 className="font-medium text-zinc-900">Email & SMS</h2>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">From name</label>
            <input value={form.emailFromName ?? ""} onChange={(e) => updateForm("emailFromName", e.target.value)}
              placeholder="My Restaurant" className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">From address</label>
            <input type="email" value={form.emailFromAddr ?? ""} onChange={(e) => updateForm("emailFromAddr", e.target.value)}
              placeholder="orders@myrestaurant.com" className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">SMS sender name</label>
            <input value={form.senderSmsName ?? ""} onChange={(e) => updateForm("senderSmsName", e.target.value)}
              placeholder="MyResto (max 11 chars)" maxLength={11}
              className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500" />
          </div>
        </div>
      </section>

      {/* Custom domains */}
      <section className="bg-white border border-zinc-200 rounded-2xl p-6 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Globe className="w-4 h-4 text-zinc-500" />
          <h2 className="font-medium text-zinc-900">Custom Domains</h2>
        </div>
        <p className="text-sm text-zinc-500">Point your own domain to your ordering storefront.</p>

        <div className="flex gap-3">
          <input value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="order.myrestaurant.com"
            className="flex-1 border border-zinc-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-500" />
          <button onClick={() => addDomainMutation.mutate()} disabled={addDomainMutation.isPending || !newDomain}
            className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-lg text-sm font-medium disabled:opacity-50">
            <Plus className="w-4 h-4" /> Add domain
          </button>
        </div>

        {branding?.customDomains?.length ? (
          <div className="space-y-2">
            {branding.customDomains.map((d) => {
              const statusInfo = DOMAIN_STATUS[d.status] ?? DOMAIN_STATUS["PENDING"]!;
              const StatusIcon = statusInfo.icon;
              return (
                <div key={d.id} className="border border-zinc-200 rounded-xl p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <code className="text-sm font-mono text-zinc-900">{d.domain}</code>
                      <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full flex items-center gap-1", statusInfo.className)}>
                        <StatusIcon className="w-3 h-3" />{statusInfo.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {(d.status === "PENDING" || d.status === "VERIFYING") && (
                        <button onClick={() => verifyDomainMutation.mutate(d.id)} disabled={verifyDomainMutation.isPending}
                          className="text-xs text-blue-600 hover:text-blue-700 font-medium">
                          Verify DNS
                        </button>
                      )}
                      {d.status === "ACTIVE" && (
                        <a href={`https://${d.domain}`} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-zinc-500 hover:text-zinc-700 flex items-center gap-1">
                          <ExternalLink className="w-3 h-3" /> Open
                        </a>
                      )}
                      <button onClick={() => removeDomainMutation.mutate(d.id)}
                        className="p-1.5 rounded text-zinc-400 hover:text-red-600 hover:bg-red-50">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  {d.txtRecord && d.status !== "ACTIVE" && (
                    <div className="bg-zinc-50 border border-zinc-100 rounded-lg p-3">
                      <div className="text-xs text-zinc-500 mb-1">Add this TXT record to your DNS provider:</div>
                      <div className="flex items-center gap-2">
                        <code className="text-xs font-mono text-zinc-700 flex-1 break-all">{d.txtRecord}</code>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-8 text-zinc-500">
            <Globe className="w-8 h-8 mx-auto mb-2 text-zinc-300" />
            No custom domains yet.
          </div>
        )}
      </section>
    </div>
  );
}
