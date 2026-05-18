// Frontend auth types — mirrored from the API DTOs.
// Do NOT import from @orderhub/shared here to keep the web bundle clean;
// these are manually kept in sync with the backend DTOs.

export type UserRole =
  | "PLATFORM_ADMIN"
  | "TENANT_OWNER"
  | "MANAGER"
  | "CASHIER"
  | "KITCHEN_STAFF"
  | "DRIVER"
  | "VIEWER";

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
