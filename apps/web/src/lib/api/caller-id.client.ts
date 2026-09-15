import { apiClient } from "./client";

// Caller ID — what we hand a shop's phone provider, and whether it worked.

export interface CallerIdRing {
  at: string;
  /** Last 4 digits only. The full number is a customer's number. */
  masked: string;
  digits: number;
  source: "webhook" | "voice" | "comet" | "test";
  /** The shop's own number arrived instead of the caller's — the provider is replacing it. */
  looksLikeShopsOwnNumber?: boolean;
  matched?: boolean;
  /** Set when a post was refused, with why. */
  rejected?: string;
}

export interface CallerIdSetup {
  locationId: string;
  locationName: string;
  /** The address to give the provider. */
  url: string;
  /** Always "x-voip-key". */
  headerName: string;
  /** This shop's own key. Null until one is created. The platform-wide key is never returned. */
  token: string | null;
  /** True when shops can still be live on the old platform-wide key. */
  sharedKeyEnabled: boolean;
  /** The number a provider would ring on the simultaneous-ring route. */
  voiceNumber: string | null;
  /** Whether "show callers without answering" is switched on for this shop. */
  callerIdOnly: boolean;
  recentRings: CallerIdRing[];
}

export const callerIdClient = {
  setup: (locationId: string) =>
    apiClient
      .get<CallerIdSetup>(`/v1/customers/caller-id/setup/${locationId}`)
      .then((r) => r.data),

  mintToken: (locationId: string) =>
    apiClient
      .post<{ token: string; url: string }>(
        `/v1/customers/caller-id/setup/${locationId}/token`,
      )
      .then((r) => r.data),

  /** Fire a ring at this shop's tills from the dashboard, to prove the popup path works. */
  testRing: (locationId: string, phone: string) =>
    apiClient
      .post(`/v1/customers/caller-id/ring`, { locationId, phone, test: true })
      .then((r) => r.data),
};
