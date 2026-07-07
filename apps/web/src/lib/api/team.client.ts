import { apiClient } from "./client";

export interface TeamMember {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  locations: { id: string; name: string }[];
  brands: { id: string; name: string }[];
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  locationIds: string[];
  brandIds: string[];
  expiresAt: string;
  createdAt: string;
  invitedBy: {
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null;
}

export interface AssignBody {
  userId: string;
  role: string;
  locationIds: string[];
  brandIds: string[];
}

export interface InviteBody {
  email: string;
  role: string;
  locationIds: string[];
  brandIds: string[];
}

export interface InvitationDetails {
  email: string;
  role: string;
  tenantName: string;
  inviterName: string;
  locations: { id: string; name: string }[];
  brands: { id: string; name: string }[];
  expiresAt: string;
}

export const teamClient = {
  listMembers: () =>
    apiClient.get<TeamMember[]>("/v1/team/members").then((r) => r.data),
  grantableRoles: () =>
    apiClient
      .get<{ roles: string[] }>("/v1/team/grantable-roles")
      .then((r) => r.data.roles),
  listInvitations: () =>
    apiClient
      .get<PendingInvitation[]>("/v1/team/invitations")
      .then((r) => r.data),
  lookupUser: (email: string) =>
    apiClient
      .get<{ user: { id: string; email: string; firstName: string | null; lastName: string | null } | null }>(
        `/v1/team/users/lookup?email=${encodeURIComponent(email)}`,
      )
      .then((r) => r.data),
  assign: (body: AssignBody) =>
    apiClient.post("/v1/team/assign", body).then((r) => r.data),
  removeMember: (userId: string) =>
    apiClient.delete(`/v1/team/members/${userId}`).then((r) => r.data),
  invite: (body: InviteBody) =>
    apiClient
      .post<{ id: string; emailError?: string | null }>(
        "/v1/team/invitations",
        body,
      )
      .then((r) => r.data),
  cancelInvitation: (id: string) =>
    apiClient.delete(`/v1/team/invitations/${id}`).then((r) => r.data),
  resendInvitation: (id: string) =>
    apiClient
      .post(`/v1/team/invitations/${id}/resend`)
      .then((r) => r.data),

  // PUBLIC — no auth header needed (apiClient still works because the
  // backend route is @Public()).
  getInviteByToken: (token: string) =>
    apiClient
      .get<InvitationDetails>(`/v1/team/invitations/by-token/${token}`)
      .then((r) => r.data),
  acceptInvite: (
    token: string,
    body: { firstName: string; lastName: string; password?: string },
  ) =>
    apiClient
      .post(`/v1/team/invitations/by-token/${token}/accept`, body)
      .then((r) => r.data),
};

export const ASSIGNABLE_ROLES: { value: string; label: string; description: string }[] = [
  { value: "OWNER", label: "Owner", description: "Full operator access to assigned locations." },
  { value: "DARK_KITCHEN_MANAGER", label: "Dark kitchen manager", description: "Multi-location kitchen operations." },
  { value: "MANAGER", label: "Manager", description: "Orders, POS, analytics for assigned locations." },
  { value: "STAFF", label: "Staff", description: "Orders + POS." },
  { value: "DRIVER", label: "Driver", description: "Driver app — orders assigned to them." },
  { value: "ONBOARDING_AGENT", label: "Onboarding agent", description: "Can create new locations and brands." },
  { value: "FINANCIAL_AGENT", label: "Financial agent", description: "Subscription management." },
];

// The account-admin roles (full tenant access) both display as "Admin".
export const ADMIN_ROLES = ["TENANT_OWNER", "PLATFORM_ADMIN"];

export function isAdminRole(role: string): boolean {
  return ADMIN_ROLES.includes(role);
}

export function humaniseRole(role: string): string {
  if (isAdminRole(role)) return "Admin";
  const known = ASSIGNABLE_ROLES.find((r) => r.value === role);
  if (known) return known.label;
  return role
    .split("_")
    .map((p) => p.charAt(0) + p.slice(1).toLowerCase())
    .join(" ");
}
