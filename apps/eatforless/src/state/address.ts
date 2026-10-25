// Where the customer is: drives which shops are shown (GET efl/shops needs a
// point) and where a delivery goes. Saved on the device — the account itself
// holds only one address (API gap, see README).

import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { MOCK, PILOT_CENTRE } from "@/config";

export type Address = {
  id: string;
  line1: string;
  line2?: string;
  city: string;
  postcode: string;
  lat: number;
  lng: number;
  /** Delivery note: flat number, buzzer, "leave with neighbour"… */
  instructions?: string;
};

type AddressState = {
  addresses: Address[];
  selectedId: string | null;
  save: (address: Address) => void;
  select: (id: string) => void;
  remove: (id: string) => void;
};

const SAMPLE: Address = {
  id: "sample-grey-street",
  line1: "14 Grey Street",
  line2: "Flat 3",
  city: "Newcastle upon Tyne",
  postcode: "NE1 6AE",
  lat: 54.97222,
  lng: -1.61213,
  instructions: "Ring the bell",
};

export const useAddresses = create<AddressState>()(
  persist(
    (set, get) => ({
      addresses: MOCK ? [SAMPLE] : [],
      selectedId: MOCK ? SAMPLE.id : null,
      save: (address) => {
        const others = get().addresses.filter((a) => a.id !== address.id);
        set({ addresses: [address, ...others], selectedId: address.id });
      },
      select: (id) => set({ selectedId: id }),
      remove: (id) => {
        const addresses = get().addresses.filter((a) => a.id !== id);
        set({ addresses, selectedId: get().selectedId === id ? (addresses[0]?.id ?? null) : get().selectedId });
      },
    }),
    { name: "efl.addresses", storage: createJSONStorage(() => AsyncStorage) },
  ),
);

export function useSelectedAddress(): Address | null {
  return useAddresses((s) => s.addresses.find((a) => a.id === s.selectedId) ?? null);
}

/** The point shops are searched around: the chosen address, else the pilot centre. */
export function searchPoint(address: Address | null) {
  return address
    ? { lat: address.lat, lng: address.lng, postcode: address.postcode, label: address.line1 }
    : { lat: PILOT_CENTRE.lat, lng: PILOT_CENTRE.lng, postcode: undefined, label: PILOT_CENTRE.label };
}
