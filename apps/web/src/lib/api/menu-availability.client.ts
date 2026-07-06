// Phase AW-14 — Menu Availability ("86 board") client.
// Phase BA — per-location scoping: pass the dashboard's selected location
// so snoozes act on THAT location only ("ALL" channel = 86 here entirely);
// omit it for the legacy every-location behaviour.

import { apiClient } from "./client";

export const CHANNELS = [
  "ONLINE",
  "POS",
  "JUST_EAT",
  "UBER_EATS",
  "DELIVEROO",
  "WHATSAPP",
  "HUBRISE",
] as const;
export type Channel = (typeof CHANNELS)[number];

/** Sentinel channel — 86 the item on EVERY channel (at the given scope). */
export type ChannelOrAll = Channel | "ALL";

export const DURATIONS = [
  "1h",
  "2h",
  "4h",
  "6h",
  "12h",
  "until_tomorrow",
  "indefinite",
] as const;
export type DurationPreset = (typeof DURATIONS)[number];

export interface InventoryItem {
  id: string;
  name: string;
  plu: string | null;
  imageUrl: string | null;
  basePrice: string;
  hasMultipleSkus: boolean;
  productSkus: Array<{ name?: string; plu?: string; price?: number }>;
  isAvailable: boolean;
  /**
   * Map of channel → snooze row. Absence means the item is available
   * for that channel. Phase BA: `locationId` null = applies at every
   * location; an id = scoped to that location (the row shown is the one
   * that applies at the requested location). "ALL" = every channel.
   */
  snoozes: Partial<
    Record<
      ChannelOrAll,
      {
        expiresAt: string | null;
        snoozeReason: string | null;
        snoozedAt: string;
        snoozedBy: string | null;
        locationId?: string | null;
      }
    >
  >;
}

export const menuAvailabilityClient = {
  getMatrix: (brandId: string, locationId?: string) =>
    apiClient
      .get<{
        sourceMenu: { id: string; name: string } | null;
        items: InventoryItem[];
      }>(`/v1/menu-availability/brands/${brandId}`, {
        params: locationId ? { locationId } : undefined,
      })
      .then((r) => r.data),

  snooze: (
    itemId: string,
    body: {
      channel: ChannelOrAll;
      duration?: DurationPreset;
      customExpiresAt?: string;
      snoozeReason?: string;
      locationId?: string;
    },
  ) =>
    apiClient
      .post(`/v1/menu-availability/items/${itemId}/snooze`, body)
      .then((r) => r.data),

  unsnooze: (itemId: string, channel: ChannelOrAll, locationId?: string) =>
    apiClient
      .post(`/v1/menu-availability/items/${itemId}/unsnooze`, {
        channel,
        ...(locationId ? { locationId } : {}),
      })
      .then((r) => r.data),

  /** Item ids 86'd entirely at this location (channel "ALL"). */
  locationItemSnoozes: (locationId: string) =>
    apiClient
      .get<{ itemIds: string[] }>(
        `/v1/menu-availability/locations/${locationId}/item-snoozes`,
      )
      .then((r) => r.data),
};
