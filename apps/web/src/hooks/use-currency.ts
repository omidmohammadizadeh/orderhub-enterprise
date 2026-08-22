"use client";

// The currently selected location's trading currency, and a formatter bound
// to it.
//
// Every price shown in the dashboard should go through this rather than a
// literal £. Currency lives on the LOCATION — it follows the till and the bank
// account — so switching location switches the currency with it, and there is
// no separate country control that can disagree with the location switcher.
//
// Falls back to GBP while the location is loading and for any shop that
// predates the column, so a UK site behaves exactly as it did before.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { formatMoney, currencySymbol, DEFAULT_CURRENCY } from "@orderhub/shared";
import { locationsClient } from "@/lib/api/locations.client";
import { queryKeys } from "@/lib/api/query-keys";
import { useSelectedLocationStore } from "@/stores/selected-location.store";

export function useCurrency(locationIdOverride?: string | null) {
  const selected = useSelectedLocationStore((s) => s.selectedLocationId);
  const locationId = locationIdOverride ?? selected;

  const { data } = useQuery({
    queryKey: queryKeys.locationDetail(locationId ?? ""),
    queryFn: () => locationsClient.get(locationId!),
    enabled: !!locationId,
    // Currency changes about never; this piggybacks on a query most screens
    // already run, so it costs nothing extra.
    staleTime: 5 * 60_000,
  });

  const currency = (data as any)?.currency || DEFAULT_CURRENCY;

  return useMemo(
    () => ({
      currency,
      symbol: currencySymbol(currency),
      /** Compact — symbol + amount, for tiles, buttons and table cells. */
      money: (n: number | string | null | undefined) =>
        formatMoney(n, currency, { compact: true }),
      /** Full locale formatting, for totals and anything read carefully. */
      moneyLong: (n: number | string | null | undefined) =>
        formatMoney(n, currency),
    }),
    [currency],
  );
}
