// The signed-in customer. The token lives in the Keychain / Keystore
// (expo-secure-store); everything else is re-fetched from /customer-auth/me on
// launch, which also slides the token's expiry forward.

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { configureClient } from "@/api/client";
import { getMe } from "@/api/efl";
import type { AuthResult, Customer } from "@/api/types";

const TOKEN_KEY = "efl.customerToken";
const ONBOARDED_KEY = "efl.onboarded";
// /customer-auth/me does not say whether the phone was verified (API gap — see
// README), so the app remembers the customer ids it has seen verify.
const VERIFIED_KEY = "efl.phoneVerifiedFor";

type SessionState = {
  hydrated: boolean;
  onboarded: boolean;
  token: string | null;
  customer: Customer | null;
  phoneVerified: boolean;
  hydrate: () => Promise<void>;
  signIn: (result: AuthResult) => Promise<void>;
  signOut: () => Promise<void>;
  setCustomer: (customer: Customer) => void;
  markPhoneVerified: (phone?: string) => Promise<void>;
  finishOnboarding: () => Promise<void>;
};

async function verifiedIds(): Promise<string[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(VERIFIED_KEY)) ?? "[]");
  } catch {
    return [];
  }
}

export const useSession = create<SessionState>((set, get) => ({
  hydrated: false,
  onboarded: false,
  token: null,
  customer: null,
  phoneVerified: false,

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
        const ids = await verifiedIds();
        set({ token: accessToken, customer, phoneVerified: ids.includes(customer.id) });
      } catch (err) {
        // Offline at launch: keep the token and try again on the next call.
        // A 401 has already cleared it through onUnauthorized.
      }
    }
    set({ hydrated: true });
  },

  signIn: async ({ accessToken, customer }) => {
    await SecureStore.setItemAsync(TOKEN_KEY, accessToken);
    await AsyncStorage.setItem(ONBOARDED_KEY, "1");
    const ids = await verifiedIds();
    set({ token: accessToken, customer, onboarded: true, phoneVerified: ids.includes(customer.id) });
  },

  signOut: async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
    set({ token: null, customer: null, phoneVerified: false });
  },

  setCustomer: (customer) => set({ customer }),

  markPhoneVerified: async (phone) => {
    const c = get().customer;
    if (!c) return;
    const ids = await verifiedIds();
    if (!ids.includes(c.id)) await AsyncStorage.setItem(VERIFIED_KEY, JSON.stringify([...ids, c.id]));
    set({ phoneVerified: true, customer: phone ? { ...c, phone } : c });
  },

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
