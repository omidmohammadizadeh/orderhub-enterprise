"use client";

// Phase AR — internal leads inbox.
// Visible to PLATFORM_ADMIN + ONBOARDING_AGENT. Lists every contact
// request submitted via the no-access screen (or the marketing form
// when that lands), with a side drawer to update status + notes.

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Search,
  Mail,
  Phone,
  Building2,
  Globe,
  Calendar,
  X,
} from "lucide-react";
import {
  leadsClient,
  LEAD_STATUSES,
  type Lead,
} from "@/lib/api/leads.client";

const STATUS_FILTERS = [
  { value: "", label: "All" },
  ...LEAD_STATUSES.map((s) => ({ value: s.value, label: s.label })),
];

export default function LeadsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Lead | null>(null);

  const leadsQuery = useQuery({
    queryKey: ["leads", status, q],
    queryFn: () =>
      leadsClient.list({ status: status || undefined, q: q || undefined }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">Leads</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Contact + demo requests captured from the no-access screen and
          marketing site.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, email, company"
            className="w-full rounded-md border border-zinc-300 pl-9 pr-3 py-2 text-sm"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s.value}
              onClick={() => setStatus(s.value)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                status === s.value
                  ? "bg-zinc-900 text-white"
                  : "bg-white border border-zinc-300 text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {leadsQuery.isLoading ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-6">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
        </div>
      ) : (leadsQuery.data ?? []).length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-12 text-center text-sm text-zinc-500">
          No leads match these filters yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="min-w-full divide-y divide-zinc-200 text-sm">
            <thead className="bg-zinc-50 text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Company</Th>
                <Th>Locations</Th>
                <Th>Source</Th>
                <Th>Status</Th>
                <Th>Submitted</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {leadsQuery.data!.map((l) => (
                <tr
                  key={l.id}
                  className="cursor-pointer hover:bg-zinc-50"
                  onClick={() => setOpen(l)}
                >
                  <Td>{l.firstName} {l.lastName}</Td>
                  <Td>
                    <span className="text-zinc-700">{l.email}</span>
                  </Td>
                  <Td>{l.companyName || "—"}</Td>
                  <Td>{l.numberOfLocations || "—"}</Td>
                  <Td>
                    <SourceLabel source={l.source} />
                  </Td>
                  <Td>
                    <StatusPill status={l.status} />
                  </Td>
                  <Td>
                    <span className="text-xs text-zinc-500">
                      {new Date(l.createdAt).toLocaleDateString()}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <LeadDrawer
          lead={open}
          onClose={() => setOpen(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["leads"] });
          }}
        />
      )}
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-4 py-3 text-left font-medium">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-3 align-top">{children}</td>;
}

function StatusPill({ status }: { status: Lead["status"] }) {
  const cfg = LEAD_STATUSES.find((s) => s.value === status);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
        cfg?.tone ?? "bg-zinc-100 text-zinc-700"
      }`}
    >
      {cfg?.label ?? status}
    </span>
  );
}

function SourceLabel({ source }: { source: Lead["source"] }) {
  const map: Record<Lead["source"], string> = {
    NO_ACCESS_SCREEN: "No-access screen",
    MARKETING_SITE: "Marketing site",
    OTHER: "Other",
  };
  return <span className="text-xs text-zinc-500">{map[source]}</span>;
}

// ────────────────────────────────────────────────────────────────────
// Lead drawer
// ────────────────────────────────────────────────────────────────────

function LeadDrawer({
  lead,
  onClose,
  onSaved,
}: {
  lead: Lead;
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  // If the lead was NEW when the drawer opened, treat the open as
  // "the operator has now seen it" and auto-flip to CONTACTED so the
  // sidebar badge clears immediately. The form below still lets them
  // pick a different status before saving.
  const [status, setStatus] = useState<Lead["status"]>(
    lead.status === "NEW" ? "CONTACTED" : lead.status,
  );
  const [notes, setNotes] = useState(lead.notes ?? "");

  useEffect(() => {
    if (lead.status !== "NEW") return;
    leadsClient
      .update(lead.id, { status: "CONTACTED" })
      .then(() => {
        qc.invalidateQueries({ queryKey: ["leads"] });
        qc.invalidateQueries({ queryKey: ["leads", "unread-count"] });
      })
      .catch(() => {
        /* best-effort — badge will refresh on next poll */
      });
    // Only fire once, when this drawer mounts for a NEW lead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useMutation({
    mutationFn: () => leadsClient.update(lead.id, { status, notes }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads", "unread-count"] });
      onSaved();
      onClose();
    },
  });

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30"
      onClick={onClose}
    >
      <div
        className="absolute right-0 top-0 h-full w-full max-w-lg overflow-y-auto bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">
            {lead.firstName} {lead.lastName}
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <Row icon={Mail} label="Email" value={lead.email} />
          {lead.phone && <Row icon={Phone} label="Phone" value={lead.phone} />}
          {lead.companyName && (
            <Row icon={Building2} label="Company" value={lead.companyName} />
          )}
          {lead.country && (
            <Row icon={Globe} label="Country" value={lead.country} />
          )}
          {lead.numberOfLocations && (
            <Row icon={Building2} label="Locations" value={lead.numberOfLocations} />
          )}
          {lead.hearAboutUs && (
            <Row icon={Globe} label="Heard about us via" value={lead.hearAboutUs} />
          )}
          <Row
            icon={Calendar}
            label="Submitted"
            value={new Date(lead.createdAt).toLocaleString()}
          />
          {lead.message && (
            <div>
              <p className="text-xs font-semibold text-zinc-600 mb-1">
                Message
              </p>
              <p className="rounded-md bg-zinc-50 p-3 text-sm text-zinc-700 whitespace-pre-wrap">
                {lead.message}
              </p>
            </div>
          )}
          {lead.submittedBy && (
            <p className="text-xs text-zinc-500">
              Submitted while signed in as {lead.submittedBy.email}
            </p>
          )}

          <div className="border-t border-zinc-200 pt-4">
            <label className="block text-xs font-semibold text-zinc-600 mb-1">
              Status
            </label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as Lead["status"])}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            >
              {LEAD_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-600 mb-1">
              Internal notes
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={5}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              placeholder="Add follow-up notes…"
            />
          </div>
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-zinc-200 bg-white px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {save.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  value,
}: {
  icon: any;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="h-3.5 w-3.5 text-zinc-400 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          {label}
        </p>
        <p className="text-sm text-zinc-700 truncate">{value}</p>
      </div>
    </div>
  );
}
