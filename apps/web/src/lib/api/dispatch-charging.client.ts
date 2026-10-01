// Admin → Dispatch charging. Per-location switch for whether a courier
// dispatch takes OrderHub's fee out of the location's wallet.
//
// Charged is the default. The waiver is a testing switch so a sandbox dispatch
// can be driven end to end without funding a wallet on a shop that will never
// take a real order.

import { apiClient } from "./client";

export interface DispatchChargingRow {
  locationId: string;
  locationName: string;
  brandName: string | null;
  waiveWalletCharge: boolean;
  note: string | null;
  updatedAt: string | null;
}

export const dispatchChargingClient = {
  list: () =>
    apiClient
      .get<DispatchChargingRow[]>("/v1/admin/dispatch-charging")
      .then((r) => r.data),

  set: (locationId: string, waiveWalletCharge: boolean, note?: string) =>
    apiClient
      .put<DispatchChargingRow>(`/v1/admin/dispatch-charging/${locationId}`, {
        waiveWalletCharge,
        note,
      })
      .then((r) => r.data),
};
