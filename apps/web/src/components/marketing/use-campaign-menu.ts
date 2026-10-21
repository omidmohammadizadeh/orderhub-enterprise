"use client";

// The menu a campaign's product picker lists. Menu.brandId is NOT the brand
// the shop trades as — a clone or an import keeps its source brand — so a
// brand-only lookup finds nothing for shops like that ("No published menu
// found"). The selected location's own menus come first; the brand's menus
// are the fallback for the "All locations" view.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { menusClient, type Menu } from "@/lib/api/menus.client";

export function pickCampaignMenu(
  locationMenus: Menu[],
  brandMenus: Menu[],
  brandId: string | null,
): Menu | null {
  const ofBrand = locationMenus.filter((m) => m.brandId === brandId);
  return (
    ofBrand.find((m) => m.isActive) ??
    ofBrand[0] ??
    locationMenus.find((m) => m.isActive) ??
    locationMenus[0] ??
    brandMenus.find((m) => m.isActive) ??
    brandMenus[0] ??
    null
  );
}

export function useCampaignMenu(brandId: string | null, locationId: string | null) {
  const locationMenusQuery = useQuery({
    queryKey: ["marketing", "location-menus", locationId],
    queryFn: () => menusClient.listMenusForLocation(locationId!),
    enabled: !!locationId,
  });
  const brandMenusQuery = useQuery({
    queryKey: ["marketing", "brand-menus", brandId],
    queryFn: () => menusClient.listMenus(brandId!),
    enabled: !!brandId,
  });

  const menu = useMemo(
    () => pickCampaignMenu(locationMenusQuery.data ?? [], brandMenusQuery.data ?? [], brandId),
    [locationMenusQuery.data, brandMenusQuery.data, brandId],
  );

  const menuQuery = useQuery({
    queryKey: ["marketing", "menu", menu?.id],
    queryFn: () => menusClient.getMenu(menu!.id),
    enabled: !!menu?.id,
  });

  return {
    categories: menuQuery.data?.categories ?? [],
    loading: locationMenusQuery.isLoading || brandMenusQuery.isLoading || menuQuery.isLoading,
  };
}
