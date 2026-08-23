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
  // `undefined` means "use whatever location the operator has selected".
  // An explicit `null` means "do not look one up at all" — which is what a
  // PUBLIC page must pass. This endpoint needs a dashboard token, and the
  // selected location is persisted in localStorage, so on a storefront the
  // query would fire with a real id, 401, and bounce the customer to /login.
  const locationId =
    locationIdOverride === undefined ? selected : locationIdOverride;

  const { data } = useQuery({
    queryKey: queryKeys.locationDetail(locationId ?? ""),
    queryFn: () => locationsClient.get(locationId!),
    enabled: !!locationId,
    // Currency changes about never; this piggybacks on a query most screens
    // already run, so it costs nothing extra.
    staleTime: 5 * 60_000,
  });

  const currency = (data as any)?.currency || DEFAULT_CURRENCY;
  // The same row already carries the country, and enough of the dashboard now
  // needs it (delivery zones, address forms, distance units) that fetching it
  // separately on each of those screens would be a query per screen for a
  // field we already have in hand.
  const country = ((data as any)?.country || "GB") as string;

  return useMemo(
    () => ({
      currency,
      country,
      symbol: currencySymbol(currency),
      /** Compact — symbol + amount, for tiles, buttons and table cells. */
      money: (n: number | string | null | undefined) =>
        formatMoney(n, currency, { compact: true }),
      /** Full locale formatting, for totals and anything read carefully. */
      moneyLong: (n: number | string | null | undefined) =>
        formatMoney(n, currency),
    }),
    [currency, country],
  );
}
