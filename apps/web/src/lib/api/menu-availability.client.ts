// Phase AW-14 — Menu Availability ("86 board") client.

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
   * for that channel.
   */
  snoozes: Partial<
    Record<
      Channel,
      {
        expiresAt: string | null;
        snoozeReason: string | null;
        snoozedAt: string;
        snoozedBy: string | null;
      }
    >
  >;
}

export const menuAvailabilityClient = {
  getMatrix: (brandId: string) =>
    apiClient
      .get<{
        sourceMenu: { id: string; name: string } | null;
        items: InventoryItem[];
      }>(`/v1/menu-availability/brands/${brandId}`)
      .then((r) => r.data),

  snooze: (
    itemId: string,
    body: {
      channel: Channel;
      duration?: DurationPreset;
      customExpiresAt?: string;
      snoozeReason?: string;
    },
  ) =>
    apiClient
      .post(`/v1/menu-availability/items/${itemId}/snooze`, body)
      .then((r) => r.data),

  unsnooze: (itemId: string, channel: Channel) =>
    apiClient
      .post(`/v1/menu-availability/items/${itemId}/unsnooze`, { channel })
      .then((r) => r.data),
};
