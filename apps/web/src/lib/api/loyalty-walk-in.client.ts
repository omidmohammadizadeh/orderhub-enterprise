// Walk-in loyalty cards (Apple/Google Wallet, scanned at the till).
//
// The public calls use plain fetch, not apiClient: the customer has no
// session, and apiClient's 401 handling would try to send them to /login.

import { apiClient } from "./client";

const BASE = "/api/v1/loyalty/walk-in";

export interface JoinInfo {
  available: boolean;
  title: string;
  color?: string;
  stampIcon?: string | null;
  logoUrl?: string | null;
  stampsRequired?: number;
  rewardLabel?: string;
  earnRule?: string;
  expiryNote?: string | null;
}

export interface PublicCard {
  title: string;
  color: string;
  stampIcon: string | null;
  logoUrl: string | null;
  firstName: string | null;
  code: string;
  scan: string;
  stamps: number;
  stampsRequired: number;
  rewardLabel: string;
  earnRule: string;
  expiryNote: string | null;
  active: boolean;
  rewards: Array<{ id: string; label: string; expiresAt: string | null }>;
  wallet: { apple: boolean; google: boolean };
}

export interface TillMember {
  id: string;
  code: string;
  firstName: string | null;
  /** "om•••@gmail.com", or "•••• 709" for older phone-only members. */
  contactHint: string | null;
  stamps: number;
  stampsRequired: number;
  stampIcon: string | null;
  lifetimeStamps: number;
  minimumSpend: number | null;
  rewardLabel: string;
  cardActive: boolean;
  rewards: Array<{
    id: string;
    label: string;
    rewardItemId: string | null;
    rewardItemName: string | null;
    amountOff: number | null;
    expiresAt: string | null;
  }>;
}

export interface WalkInOverview {
  joinUrl: string;
  defaultTitle: string;
  defaultLogoUrl: string | null;
  members: number;
  joinedThisWeek: number;
  stampsThisMonth: number;
  rewardsClaimed: number;
  walletReady: { apple: boolean; google: boolean; email: boolean };
}

async function publicJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = Array.isArray(body?.message) ? body.message[0] : body?.message;
    throw new Error(msg || "Something went wrong. Please try again.");
  }
  return body as T;
}

export const walkInPublic = {
  joinInfo: (shop: string) => publicJson<JoinInfo>(`/join/${encodeURIComponent(shop)}`),
  join: (shop: string, body: { firstName?: string; email: string; marketingConsent: boolean }) =>
    publicJson<
      | { status: "CREATED"; token: string }
      | { status: "VERIFY"; contactHint: string; via: "email" | "sms" }
      | { status: "EXISTING"; sent: false }
    >(`/join/${encodeURIComponent(shop)}`, { method: "POST", body: JSON.stringify(body) }),
  verify: (shop: string, body: { email: string; code: string }) =>
    publicJson<{ token: string }>(`/join/${encodeURIComponent(shop)}/verify`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  card: (token: string) => publicJson<PublicCard>(`/card/${encodeURIComponent(token)}`),
  appleUrl: (token: string) => `${BASE}/card/${encodeURIComponent(token)}/loyalty.pkpass`,
  googleUrl: (token: string) => publicJson<{ url: string }>(`/card/${encodeURIComponent(token)}/google`),
};

export interface TillStatus {
  enabled: boolean;
  stampIcon: string | null;
  stampsRequired: number;
  rewardLabel: string | null;
  joinUrl: string;
}

export const walkInTill = {
  status: (locationId: string) =>
    apiClient
      .get<TillStatus>("/v1/loyalty/walk-in/till-status", { params: { locationId } })
      .then((r) => r.data),
  lookup: (locationId: string, q: string) =>
    apiClient
      .get<TillMember>("/v1/loyalty/walk-in/lookup", { params: { locationId, q } })
      .then((r) => r.data),
  enrol: (body: { locationId: string; email: string; firstName?: string; marketingConsent?: boolean }) =>
    apiClient
      .post<{ existing: boolean; sent: boolean; via: "email" | "sms"; cardUrl: string | null; member: TillMember }>(
        "/v1/loyalty/walk-in/enrol",
        body,
      )
      .then((r) => r.data),
  cardLink: (memberId: string) =>
    apiClient
      .post<{ cardUrl: string }>(`/v1/loyalty/walk-in/members/${memberId}/card-link`)
      .then((r) => r.data),
  resend: (memberId: string) =>
    apiClient
      .post<{ sent: boolean; via: "email" | "sms" }>(`/v1/loyalty/walk-in/members/${memberId}/resend`)
      .then((r) => r.data),
  overview: (locationId: string) =>
    apiClient.get<WalkInOverview>(`/v1/loyalty/walk-in/overview/${locationId}`).then((r) => r.data),
};
