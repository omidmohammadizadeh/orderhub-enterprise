// Frontend auth types — mirrored from the API DTOs.
// Do NOT import from @orderhub/shared here to keep the web bundle clean;
// these are manually kept in sync with the backend DTOs.

// Mirrors the API's UserRole enum. This had drifted — the Team Roles
// (OWNER, DARK_KITCHEN_MANAGER, STAFF, ONBOARDING_AGENT, FINANCIAL_AGENT)
// are assignable in the Team Roles UI and returned by /auth/me, but were
// missing here, so any comparison against them failed to typecheck and
// role checks had to cast through `string`.
export type UserRole =
  | "PLATFORM_ADMIN"
  | "TENANT_OWNER"
  | "MANAGER"
  | "CASHIER"
  | "KITCHEN_STAFF"
  | "DRIVER"
  | "VIEWER"
  // Team Roles
  | "OWNER"
  | "DARK_KITCHEN_MANAGER"
  | "STAFF"
  | "ONBOARDING_AGENT"
  | "FINANCIAL_AGENT"
  // Device accounts, not people — each reaches exactly one tab.
  | "KIOSK"
  | "KITCHEN_DISPLAY";

export interface UserProfile {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  role: UserRole;
  permissions: string[];
  tenantId: string;
  tenantName: string;
  isVerified: boolean;
  brandId: string | null;
  defaultLocationId: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginResponse {
  tokens: AuthTokens;
  user: UserProfile;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

// What the Zustand auth store holds
export interface AuthState {
  user: UserProfile | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
}
