"use client";

import { useEffect, useState } from "react";

/** The white-label restaurant apps (apps/customer) show the storefront in a
 *  WebView whose user agent ends in "OrderHubApp/<brand>". */
export function inRestaurantApp(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("OrderHubApp/");
}

/** Same answer as a hook. False on the server and the first client render, so
 *  the HTML the server sent and the first paint agree. */
export function useInRestaurantApp(): boolean {
  const [inApp, setInApp] = useState(false);
  useEffect(() => setInApp(inRestaurantApp()), []);
  return inApp;
}
