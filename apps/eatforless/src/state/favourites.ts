// Saved shops, kept on the device (no favourites endpoint yet — README → API gaps).

import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type FavState = { ids: string[]; toggle: (id: string) => void };

export const useFavourites = create<FavState>()(
  persist(
    (set, get) => ({
      ids: [],
      toggle: (id) => set({ ids: get().ids.includes(id) ? get().ids.filter((x) => x !== id) : [...get().ids, id] }),
    }),
    { name: "efl.favourites", storage: createJSONStorage(() => AsyncStorage) },
  ),
);
