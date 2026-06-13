"use client";

// Phase AR — Team Roles dashboard page.
//
// Two top buttons (Assign Role / Invite Team Member) → modals.
// Two tabs: Members + Pending Invitations.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  UserPlus,
  Mail,
  Search,
  Trash2,
  Loader2,
  X,
  Check,
  Clock,
  Building2,
  MapPin,
} from "lucide-react";
import {
  teamClient,
  type TeamMember,
  type PendingInvitation,
  ASSIGNABLE_ROLES,
  humaniseRole,
} from "@/lib/api/team.client";
import { locationsClient, brandsClient } from "@/lib/api/locations.client";

type Tab = "members" | "invites";

export default function TeamRolesPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("members");
  const [modal, setModal] = useState<"assign" | "invite" | null>(null);

  const membersQuery = useQuery({
    queryKey: ["team", "members"],
    queryFn: teamClient.listMembers,
  });
  const invitesQuery = useQuery({
    queryKey: ["team", "invites"],
    queryFn: teamClient.listInvitations,
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Team Roles</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Invite team members and scope their access to specific locations and brands.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setModal("assign")}
            className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            <UserPlus className="h-4 w-4" /> Assign role
          </button>
          <button
            onClick={() => setModal("invite")}
            className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700"
          >
            <Mail className="h-4 w-4" /> Invite team member
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-zinc-200">
        <div className="flex gap-1">
          <TabBtn active={tab === "members"} onClick={() => setTab("members")}>
            Members{" "}
            {membersQuery.data && (
              <span className="text-xs text-zinc-400">
                ({membersQuery.data.length})
              </span>
            )}
          </TabBtn>
          <TabBtn active={tab === "invites"} onClick={() => setTab("invites")}>
            Pending invitations{" "}
            {invitesQuery.data && (
              <span className="text-xs text-zinc-400">
                ({invitesQuery.data.length})
              </span>
            )}
          </TabBtn>
        </div>
      </div>

      {/* Tab bodies */}
      {tab === "members" ? (
        <MembersTable
          loading={membersQuery.isLoading}
          members={membersQuery.data ?? []}
        />
      ) : (
        <InvitesTable
          loading={invitesQuery.isLoading}
          invites={invitesQuery.data ?? []}
          onCancel={async (id) => {
            await teamClient.cancelInvitation(id);
            qc.invalidateQueries({ queryKey: ["team", "invites"] });
          }}
        />
      )}

      {modal && (
        <RoleModal
          mode={modal}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            qc.invalidateQueries({ queryKey: ["team", "members"] });
            qc.invalidateQueries({ queryKey: ["team", "invites"] });
          }}
        />
      )}
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
        active
          ? "border-violet-600 text-violet-700"
          : "border-transparent text-zinc-500 hover:text-zinc-700"
      }`}
    >
      {children}
    </button>
  );
}

function MembersTable({
  loading,
  members,
}: {
  loading: boolean;
  members: TeamMember[];
}) {
  if (loading) return <Skeleton />;
  if (!members.length) return <Empty message="No team members yet." />;
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <table className="min-w-full divide-y divide-zinc-200 text-sm">
        <thead className="bg-zinc-50 text-xs uppercase tracking-wider text-zinc-500">
          <tr>
            <Th>Name</Th>
            <Th>Email</Th>
            <Th>Role</Th>
            <Th>Locations</Th>
            <Th>Brands</Th>
            <Th>Last login</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {members.map((m) => (
            <tr key={m.id}>
              <Td>
                {[m.firstName, m.lastName].filter(Boolean).join(" ") || (
                  <span className="text-zinc-400">—</span>
                )}
              </Td>
              <Td>{m.email}</Td>
              <Td>
                <RolePill role={m.role} />
              </Td>
              <Td>
                <ScopeList items={m.locations.map((l) => l.name)} icon={MapPin} />
              </Td>
              <Td>
                <ScopeList items={m.brands.map((b) => b.name)} icon={Building2} />
              </Td>
              <Td>
                <span className="text-xs text-zinc-500">
                  {m.lastLoginAt
                    ? new Date(m.lastLoginAt).toLocaleDateString()
                    : "Never"}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InvitesTable({
  loading,
  invites,
  onCancel,
}: {
  loading: boolean;
  invites: PendingInvitation[];
  onCancel: (id: string) => void;
}) {
  if (loading) return <Skeleton />;
  if (!invites.length)
    return <Empty message="No pending invitations." />;
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <table className="min-w-full divide-y divide-zinc-200 text-sm">
        <thead className="bg-zinc-50 text-xs uppercase tracking-wider text-zinc-500">
          <tr>
            <Th>Email</Th>
            <Th>Role</Th>
            <Th>Invited by</Th>
            <Th>Sent</Th>
            <Th>Expires</Th>
            <Th></Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {invites.map((i) => (
            <tr key={i.id}>
              <Td>{i.email}</Td>
              <Td>
                <RolePill role={i.role} />
              </Td>
              <Td>
                {i.invitedBy
                  ? [i.invitedBy.firstName, i.invitedBy.lastName]
                      .filter(Boolean)
                      .join(" ") || i.invitedBy.email
                  : "—"}
              </Td>
              <Td>
                <span className="text-xs text-zinc-500">
                  {new Date(i.createdAt).toLocaleDateString()}
                </span>
              </Td>
              <Td>
                <span className="text-xs text-zinc-500">
                  {new Date(i.expiresAt).toLocaleDateString()}
                </span>
              </Td>
              <Td>
                <button
                  onClick={() => onCancel(i.id)}
                  className="text-zinc-400 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-left font-medium">{children}</th>
  );
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-3 align-top">{children}</td>;
}

function RolePill({ role }: { role: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-violet-50 px-2 py-0.5 text-xs font-semibold text-violet-700">
      {humaniseRole(role)}
    </span>
  );
}

function ScopeList({
  items,
  icon: Icon,
}: {
  items: string[];
  icon: any;
}) {
  if (!items.length)
    return <span className="text-xs text-zinc-400">All / —</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.slice(0, 3).map((name) => (
        <span
          key={name}
          className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700"
        >
          <Icon className="h-3 w-3" /> {name}
        </span>
      ))}
      {items.length > 3 && (
        <span className="text-xs text-zinc-500">
          +{items.length - 3} more
        </span>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6">
      <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
    </div>
  );
}
function Empty({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-12 text-center text-sm text-zinc-500">
      {message}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Assign / Invite modal
// ────────────────────────────────────────────────────────────────────

function RoleModal({
  mode,
  onClose,
  onSaved,
}: {
  mode: "assign" | "invite";
  onClose: () => void;
  onSaved: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("MANAGER");
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [brandIds, setBrandIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // For Assign flow: resolve existing user id by email
  const [lookupState, setLookupState] = useState<
    | { kind: "idle" }
    | { kind: "searching" }
    | {
        kind: "found";
        user: { id: string; email: string; firstName: string | null; lastName: string | null };
      }
    | { kind: "notfound" }
  >({ kind: "idle" });

  const locationsQuery = useQuery({
    queryKey: ["locations", "list"],
    queryFn: locationsClient.list,
  });
  const brandsQuery = useQuery({
    queryKey: ["brands", "list", locationIds.join(",") || "all"],
    queryFn: () => brandsClient.list(),
  });

  // Brands visible in the picker = brands whose primaryLocationId is in
  // the selected set, OR brands without primaryLocationId (franchise
  // parents) when locations are selected. When no locations selected,
  // show everything so the operator can scope brands first if they
  // prefer.
  const visibleBrands = useMemo(() => {
    const all = brandsQuery.data ?? [];
    if (!locationIds.length) return all;
    return all.filter(
      (b: any) =>
        !b.primaryLocationId || locationIds.includes(b.primaryLocationId),
    );
  }, [brandsQuery.data, locationIds]);

  const lookup = useMutation({
    mutationFn: () => teamClient.lookupUser(email),
    onSuccess: (data) => {
      if (data.user) setLookupState({ kind: "found", user: data.user });
      else setLookupState({ kind: "notfound" });
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      setError(null);
      if (mode === "assign") {
        if (lookupState.kind !== "found") {
          throw new Error("Look up a user by email first.");
        }
        await teamClient.assign({
          userId: lookupState.user.id,
          role,
          locationIds,
          brandIds,
        });
      } else {
        await teamClient.invite({
          email: email.trim(),
          role,
          locationIds,
          brandIds,
        });
      }
    },
    onSuccess: onSaved,
    onError: (err: any) =>
      setError(
        err?.response?.data?.message ?? err?.message ?? "Save failed.",
      ),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900">
            {mode === "assign"
              ? "Assign role to existing user"
              : "Invite team member"}
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5 max-h-[70vh] overflow-y-auto">
          {/* Email */}
          <div>
            <label className="block text-xs font-semibold text-zinc-600 mb-1">
              Email
            </label>
            <div className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setLookupState({ kind: "idle" });
                }}
                placeholder="person@example.com"
                className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
              />
              {mode === "assign" && (
                <button
                  type="button"
                  disabled={!email || lookup.isPending}
                  onClick={() => {
                    setLookupState({ kind: "searching" });
                    lookup.mutate();
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                >
                  {lookup.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search className="h-3.5 w-3.5" />
                  )}
                  Find
                </button>
              )}
            </div>
            {lookupState.kind === "found" && (
              <p className="mt-1 text-xs text-emerald-700">
                <Check className="inline h-3 w-3" /> User found:{" "}
                {[lookupState.user.firstName, lookupState.user.lastName]
                  .filter(Boolean)
                  .join(" ") || lookupState.user.email}
              </p>
            )}
            {lookupState.kind === "notfound" && (
              <p className="mt-1 text-xs text-amber-700">
                No user found with that email — use "Invite team member"
                instead.
              </p>
            )}
          </div>

          {/* Role */}
          <div>
            <label className="block text-xs font-semibold text-zinc-600 mb-1">
              Role
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
            >
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-zinc-500">
              {ASSIGNABLE_ROLES.find((r) => r.value === role)?.description}
            </p>
          </div>

          {/* Locations */}
          <MultiPicker
            label="Locations"
            options={(locationsQuery.data ?? []).map((l: any) => ({
              id: l.id,
              name: l.name,
            }))}
            selected={locationIds}
            onChange={setLocationIds}
            empty="No locations available."
          />

          {/* Brands */}
          <MultiPicker
            label="Brands (within selected locations)"
            options={visibleBrands.map((b: any) => ({ id: b.id, name: b.name }))}
            selected={brandIds}
            onChange={setBrandIds}
            empty="No brands available yet."
          />

          {error && (
            <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={
              save.isPending ||
              !email ||
              (mode === "assign" && lookupState.kind !== "found")
            }
            className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {save.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            {mode === "assign" ? "Assign role" : "Send invitation"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MultiPicker({
  label,
  options,
  selected,
  onChange,
  empty,
}: {
  label: string;
  options: { id: string; name: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  empty: string;
}) {
  const toggle = (id: string) =>
    onChange(
      selected.includes(id)
        ? selected.filter((s) => s !== id)
        : [...selected, id],
    );
  return (
    <div>
      <label className="block text-xs font-semibold text-zinc-600 mb-1">
        {label}
      </label>
      {options.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 px-3 py-3 text-xs text-zinc-500">
          {empty}
        </p>
      ) : (
        <div className="max-h-36 overflow-y-auto rounded-md border border-zinc-300 p-2 space-y-1">
          {options.map((o) => (
            <label
              key={o.id}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-zinc-50"
            >
              <input
                type="checkbox"
                checked={selected.includes(o.id)}
                onChange={() => toggle(o.id)}
              />
              <span>{o.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
