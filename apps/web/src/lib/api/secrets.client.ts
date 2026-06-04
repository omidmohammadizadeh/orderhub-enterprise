import { apiClient } from "./client";

// Phase AP — System Secrets vault. The /v1/secrets API is admin-only
// AND requires a per-session "unlock" JWT before any reveal / write
// action. The unlock token lives in memory only (not localStorage) and
// is sent as X-Secrets-Unlock on every protected request.

export interface SecretMetadata {
  id: string;
  key: string;
  label: string | null;
  description: string | null;
  category: string | null;
  lastFourChars: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export const secretsClient = {
  status: () =>
    apiClient.get<{ enabled: boolean }>("/v1/secrets/status").then((r) => r.data),

  unlock: (password: string) =>
    apiClient
      .post<{ token: string; expiresIn: number }>("/v1/secrets/unlock", {
        password,
      })
      .then((r) => r.data),

  list: () =>
    apiClient.get<SecretMetadata[]>("/v1/secrets").then((r) => r.data),

  reveal: (key: string, unlockToken: string) =>
    apiClient
      .get<{ key: string; value: string }>(
        `/v1/secrets/${encodeURIComponent(key)}/value`,
        { headers: { "X-Secrets-Unlock": unlockToken } },
      )
      .then((r) => r.data),

  upsert: (
    key: string,
    unlockToken: string,
    body: { value: string; label?: string; description?: string; category?: string },
  ) =>
    apiClient
      .put<SecretMetadata>(`/v1/secrets/${encodeURIComponent(key)}`, body, {
        headers: { "X-Secrets-Unlock": unlockToken },
      })
      .then((r) => r.data),

  remove: (key: string, unlockToken: string) =>
    apiClient.delete(`/v1/secrets/${encodeURIComponent(key)}`, {
      headers: { "X-Secrets-Unlock": unlockToken },
    }),
};
