import { apiClient } from "./client";
import type {
  LoginCredentials,
  LoginResponse,
  AuthTokens,
  UserProfile,
} from "../../types/auth.types";

// Typed auth API client — the only place auth HTTP calls are made.
// Components and stores use these functions, never raw axios calls.
export const authClient = {
  // POST /api/v1/auth/login
  async login(credentials: LoginCredentials): Promise<LoginResponse> {
    const { data } = await apiClient.post<LoginResponse>(
      "/v1/auth/login",
      credentials,
    );
    return data;
  },

  // POST /api/v1/auth/refresh
  // Called automatically by the Axios interceptor — components rarely need this.
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const { data } = await apiClient.post<AuthTokens>("/v1/auth/refresh", {
      refreshToken,
    });
    return data;
  },

  // POST /api/v1/auth/logout
  async logout(refreshToken: string): Promise<void> {
    await apiClient.post("/v1/auth/logout", { refreshToken });
  },

  // DELETE /api/v1/auth/sessions (logout all devices)
  async logoutAll(): Promise<void> {
    await apiClient.delete("/v1/auth/sessions");
  },

  // GET /api/v1/auth/me
  async getMe(): Promise<UserProfile> {
    const { data } = await apiClient.get<UserProfile>("/v1/auth/me");
    return data;
  },

  // PATCH /api/v1/auth/me — update own profile (name + avatar)
  async updateProfile(input: {
    firstName?: string;
    lastName?: string;
    avatarUrl?: string | null;
  }): Promise<UserProfile> {
    const { data } = await apiClient.patch<UserProfile>("/v1/auth/me", input);
    return data;
  },

  // POST /api/v1/auth/change-password
  async changePassword(input: {
    currentPassword?: string;
    newPassword: string;
  }): Promise<void> {
    await apiClient.post("/v1/auth/change-password", input);
  },

  // DELETE /api/v1/auth/me — permanently delete own account
  async deleteAccount(confirm: string): Promise<void> {
    await apiClient.delete("/v1/auth/me", { data: { confirm } });
  },
};
