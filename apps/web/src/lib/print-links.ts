import type { MouseEvent } from "react";
import toast from "react-hot-toast";
import { apiClient } from "@/lib/api/client";

// The A4 print pages (/print/assembly-charts, /print/build-guides,
// /print/menu-presentation) read the API, so they need a session.
//
// On a desktop the new tab shares the signed-in browser's localStorage and
// just works. In the tablet app it does not: a target="_blank" link leaves the
// WebView for the device's own browser, where nobody is signed in — staff hit
// "Download PDF" and landed on /login. So inside the app we mint a short-lived
// signed link (?pt=…) and open THAT in the device browser, which can also do
// the print / Save-as-PDF dialog the WebView can't.

export type PrintLinkKind = "charts-menu" | "charts-item" | "guides-menu" | "guides-item" | "presentation";
export type PrintLink = { kind: PrintLinkKind; id: string };

type NativeBridge = { openExternal?: (url: string) => void };

function nativeBridge(): NativeBridge | null {
  if (typeof window === "undefined") return null;
  const b = (window as unknown as { OrderHubNative?: NativeBridge }).OrderHubNative;
  return b?.openExternal ? b : null;
}

export const printLinksClient = {
  create: (link: PrintLink) => apiClient.post<{ token: string }>("/v1/print-links", link).then((r) => r.data.token),
  read: <T>(token: string) => apiClient.get<T>(`/v1/print-links/${encodeURIComponent(token)}`).then((r) => r.data),
};

async function openInDeviceBrowser(bridge: NativeBridge, path: string, link: PrintLink) {
  const token = await printLinksClient.create(link);
  const url = new URL(path, window.location.origin);
  url.searchParams.set("pt", token);
  bridge.openExternal!(url.toString());
}

/** Open a print page in a new tab — or, in the tablet app, in the device browser via a signed link. */
export function openPrintPage(path: string, link: PrintLink) {
  const bridge = nativeBridge();
  if (!bridge) {
    window.open(path, "_blank");
    return;
  }
  void openInDeviceBrowser(bridge, path, link).catch(() => toast.error("Couldn't open the print page — try again"));
}

/** onClick for an <a href={path} target="_blank">: leaves desktops alone, reroutes the tablet app. */
export function printLinkClick(e: MouseEvent<HTMLAnchorElement>, path: string, link: PrintLink) {
  const bridge = nativeBridge();
  if (!bridge) return;
  e.preventDefault();
  void openInDeviceBrowser(bridge, path, link).catch(() => toast.error("Couldn't open the print page — try again"));
}
