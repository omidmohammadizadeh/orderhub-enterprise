"use client";

import { useEffect, useState } from "react";
import {
  SITE_BRANDS,
  brandKeyFromHost,
  type SiteBrand,
} from "./site-brand";

/**
 * Client-side brand resolver for Client Components (e.g. the detail-page
 * shell). Reads window.location.hostname after mount. Defaults to Order Hub
 * for SSR/first paint; on menumanager.uk it swaps to Menu Manager on hydrate.
 */
export function useSiteBrand(): SiteBrand {
  const [brand, setBrand] = useState<SiteBrand>(SITE_BRANDS.orderhub);
  useEffect(() => {
    setBrand(SITE_BRANDS[brandKeyFromHost(window.location.hostname)]);
  }, []);
  return brand;
}
