// Phase AY (P6) — thin client over the per-location WhatsApp connection
// endpoints (mirrors hubrise.client.ts).

import { apiClient } from "./client";

export interface WhatsAppConnection {
  configured: boolean;
  enabled: boolean;
  status: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  wabaId: string;
  menuId: string;
  menus: { id: string; name: string }[];
  verifiedName: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
  webhookUrl: string;
  verifyToken: string;
}

export interface SaveWhatsAppConnection {
  locationId: string;
  enabled: boolean;
  phoneNumberId: string;
  displayPhoneNumber?: string;
  wabaId?: string;
  menuId?: string;
}

export const whatsappClient = {
  get: (locationId: string) =>
    apiClient
      .get<WhatsAppConnection>(`/v1/whatsapp/connection`, { params: { locationId } })
      .then((r) => r.data),

  save: (dto: SaveWhatsAppConnection) =>
    apiClient.put<WhatsAppConnection>(`/v1/whatsapp/connection`, dto).then((r) => r.data),

  test: (locationId: string) =>
    apiClient
      .post<{ ok: boolean; verifiedName: string | null; displayPhoneNumber: string | null }>(
        `/v1/whatsapp/connection/test`,
        { locationId },
      )
      .then((r) => r.data),
};
