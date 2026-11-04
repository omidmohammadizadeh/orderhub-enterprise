// Saved shops. Signed in, they live on the account (efl/me/favourites);
// signed out, on the device. A heart tapped while browsing is carried over
// to the account at sign-in.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { getFavourites, setFavourite } from "@/api/efl";

type FavState = {
  local: string[];
  /** The account's favourites; null while signed out. */
  remote: string[] | null;
  toggle: (id: string) => void;
  loadRemote: () => Promise<void>;
  dropRemote: () => void;
};

export const useFavourites = create<FavState>()(
  persist(
    (set, get) => ({
      local: [],
      remote: null,

      toggle: (id) => {
        const { remote, local } = get();
        if (!remote) {
          set({ local: local.includes(id) ? local.filter((x) => x !== id) : [...local, id] });
          return;
        }
        const on = !remote.includes(id);
        // Optimistic: the heart fills now and rolls back if the call fails.
        set({ remote: on ? [id, ...remote] : remote.filter((x) => x !== id) });
        setFavourite(id, on).catch(() => set({ remote }));
      },

      loadRemote: async () => {
        const { local } = get();
        const remote = await getFavourites();
        const missing = local.filter((id) => !remote.includes(id));
        await Promise.all(missing.map((id) => setFavourite(id, true).catch(() => null)));
        set({ remote: [...missing, ...remote], local: [] });
      },

      dropRemote: () => set({ remote: null }),
    }),
    {
      name: "efl.favourites",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ local }) => ({ local }),
      version: 2,
      migrate: (persisted: any) => ({ local: persisted?.ids ?? persisted?.local ?? [] }),
    },
  ),
);

export function useIsFavourite(id: string): boolean {
  return useFavourites((s) => (s.remote ?? s.local).includes(id));
}
