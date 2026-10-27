// The signed-in customer. The token lives in the Keychain / Keystore
// (expo-secure-store); the account comes from /customer-auth/me on launch
// (which also slides the token's expiry forward) and the Eat For Less flags —
// phone verified, marketing opt-in — from /efl/me.

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { configureClient } from "@/api/client";
import { getEflMe, getMe } from "@/api/efl";
import type { AuthResult, Customer } from "@/api/types";

const TOKEN_KEY = "efl.customerToken";
const ONBOARDED_KEY = "efl.onboarded";

type SessionState = {
  hydrated: boolean;
  onboarded: boolean;
  token: string | null;
  customer: Customer | null;
  phoneVerified: boolean;
  marketingOptIn: boolean;
  hydrate: () => Promise<void>;
  signIn: (result: AuthResult) => Promise<void>;
  signOut: () => Promise<void>;
  setCustomer: (customer: Customer) => void;
  /** Re-reads GET efl/me. Quietly keeps the last values when offline. */
  refreshFlags: () => Promise<void>;
  setMarketingOptIn: (optIn: boolean) => void;
  finishOnboarding: () => Promise<void>;
};

export const useSession = create<SessionState>((set, get) => ({
  hydrated: false,
  onboarded: false,
  token: null,
  customer: null,
  phoneVerified: false,
  marketingOptIn: false,

  hydrate: async () => {
    const [token, onboarded] = await Promise.all([
      SecureStore.getItemAsync(TOKEN_KEY).catch(() => null),
      AsyncStorage.getItem(ONBOARDED_KEY).catch(() => null),
    ]);
    set({ token, onboarded: onboarded === "1" });
    if (token) {
      try {
        const { accessToken, ...customer } = await getMe();
        await SecureStore.setItemAsync(TOKEN_KEY, accessToken);
        set({ token: accessToken, customer });
        await get().refreshFlags();
      } catch {
        // Offline at launch: keep the token and try again on the next call.
        // A 401 has already cleared it through onUnauthorized.
      }
    }
    set({ hydrated: true });
  },

  signIn: async ({ accessToken, customer }) => {
    await SecureStore.setItemAsync(TOKEN_KEY, accessToken);
    await AsyncStorage.setItem(ONBOARDED_KEY, "1");
    set({ token: accessToken, customer, onboarded: true });
    await get().refreshFlags();
  },

  signOut: async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
    set({ token: null, customer: null, phoneVerified: false, marketingOptIn: false });
  },

  setCustomer: (customer) => set({ customer }),

  refreshFlags: async () => {
    if (!get().token) return;
    try {
      const me = await getEflMe();
      const c = get().customer;
      set({
        phoneVerified: me.phoneVerified,
        marketingOptIn: me.marketingOptIn,
        customer: c && me.phone ? { ...c, phone: me.phone } : c,
      });
    } catch {
      /* offline: keep what we had */
    }
  },

  setMarketingOptIn: (optIn) => set({ marketingOptIn: optIn }),

  finishOnboarding: async () => {
    await AsyncStorage.setItem(ONBOARDED_KEY, "1");
    set({ onboarded: true });
  },
}));

configureClient({
  getToken: () => useSession.getState().token,
  onUnauthorized: () => {
    void useSession.getState().signOut();
  },
});
