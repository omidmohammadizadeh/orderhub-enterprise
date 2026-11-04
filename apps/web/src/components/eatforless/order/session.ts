"use client";

// Who is ordering. The token lives in localStorage (one per browser, the same
// account as the app); on load it is checked against the API, which hands back
// a fresh one, and a rejected token signs the visitor out quietly.

import { useEffect } from "react";
import { create } from "zustand";
import {
  eflCustomerApi,
  readEflToken,
  setEflUnauthorizedHandler,
  writeEflToken,
  type EflAuthResult,
  type EflCustomer,
} from "@/lib/api/efl-customer";

type SessionState = {
  /** "unknown" until the stored token has been read. */
  status: "unknown" | "signedOut" | "signedIn";
  customer: EflCustomer | null;
  phoneVerified: boolean;
  phone: string | null;
  signIn: (result: EflAuthResult) => void;
  signOut: () => void;
  /** Re-reads the account and its Eat For Less flags. */
  refresh: () => Promise<void>;
};

export const useEflSession = create<SessionState>()((set, get) => ({
  status: "unknown",
  customer: null,
  phoneVerified: false,
  phone: null,

  signIn: (result) => {
    writeEflToken(result.accessToken);
    set({ status: "signedIn", customer: result.customer, phone: result.customer.phone });
    void get().refresh();
  },

  signOut: () => {
    writeEflToken(null);
    set({ status: "signedOut", customer: null, phoneVerified: false, phone: null });
  },

  refresh: async () => {
    if (!readEflToken()) {
      set({ status: "signedOut", customer: null, phoneVerified: false, phone: null });
      return;
    }
    try {
      const [me, flags] = await Promise.all([eflCustomerApi.me(), eflCustomerApi.eflMe()]);
      if (me.accessToken) writeEflToken(me.accessToken);
      const { accessToken: _token, ...customer } = me;
      set({ status: "signedIn", customer, phoneVerified: flags.phoneVerified, phone: flags.phone ?? customer.phone });
    } catch {
      // A 401 already signed them out (below); offline keeps what we had.
      if (get().status === "unknown") set({ status: readEflToken() ? "signedIn" : "signedOut" });
    }
  },
}));

let hydrated = false;

/** Mount once per page that needs to know who is signed in. */
export function useHydrateEflSession(): void {
  useEffect(() => {
    if (hydrated) return;
    hydrated = true;
    setEflUnauthorizedHandler(() => useEflSession.getState().signOut());
    void useEflSession.getState().refresh();
  }, []);
}

export function customerName(c: EflCustomer | null): string {
  return c ? `${c.firstName} ${c.lastName}`.trim() : "";
}
