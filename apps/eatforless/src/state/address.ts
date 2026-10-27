// Where the customer is: drives which shops are shown (GET efl/shops needs a
// point) and where a delivery goes.
//
// Signed in, addresses live on the account (efl/me/addresses, up to 10, one
// default). Signed out, they live on the device so browsing still works; the
// device list is offered up to the account the first time someone signs in
// with an empty one.

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { addAddress, deleteAddress, getAddresses, updateAddress } from "@/api/efl";
import type { SavedAddress } from "@/api/types";
import { MOCK, PILOT_CENTRE } from "@/config";

export type Address = {
  id: string;
  label?: string;
  line1: string;
  line2?: string;
  city: string;
  postcode: string;
  lat: number;
  lng: number;
  /** Delivery note: flat number, buzzer, "leave with neighbour"… */
  instructions?: string;
  isDefault?: boolean;
};

type AddressState = {
  /** Device-only addresses (signed out). Persisted. */
  local: Address[];
  /** The account's addresses; null while signed out. Not persisted. */
  remote: Address[] | null;
  selectedId: string | null;
  save: (address: Omit<Address, "id"> & { id?: string }) => Promise<void>;
  select: (id: string) => void;
  remove: (id: string) => Promise<void>;
  /** Signed in: load the account's list (and seed it from the device once). */
  loadRemote: () => Promise<void>;
  /** Signed out: back to the device list. */
  dropRemote: () => void;
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

/** A saved row → an app address. Rows saved without a point are placed with
 *  the phone's geocoder; ones that can't be placed are left out. */
async function fromSaved(row: SavedAddress): Promise<Address | null> {
  let lat = row.latitude;
  let lng = row.longitude;
  if (lat == null || lng == null) {
    const [hit] = await Location.geocodeAsync(`${row.line1}, ${row.city}, ${row.postcode}, UK`).catch(() => []);
    if (!hit) return null;
    lat = hit.latitude;
    lng = hit.longitude;
  }
  return {
    id: row.id,
    label: row.label ?? undefined,
    line1: row.line1,
    line2: row.line2 ?? undefined,
    city: row.city,
    postcode: row.postcode,
    lat,
    lng,
    instructions: row.instructions ?? undefined,
    isDefault: row.isDefault,
  };
}

function toBody(a: Omit<Address, "id">) {
  return {
    label: a.label ?? null,
    line1: a.line1,
    line2: a.line2 ?? null,
    city: a.city,
    postcode: a.postcode,
    latitude: a.lat,
    longitude: a.lng,
    instructions: a.instructions ?? null,
  };
}

export const useAddresses = create<AddressState>()(
  persist(
    (set, get) => ({
      local: MOCK ? [SAMPLE] : [],
      remote: null,
      selectedId: MOCK ? SAMPLE.id : null,

      save: async (address) => {
        const { remote, local } = get();
        if (remote) {
          const row = address.id
            ? await updateAddress(address.id, toBody(address))
            : await addAddress({ ...toBody(address), isDefault: remote.length === 0 });
          const saved = await fromSaved(row);
          await get().loadRemote();
          if (saved) set({ selectedId: saved.id });
          return;
        }
        const id = address.id ?? `addr-${Date.now()}`;
        set({ local: [{ ...address, id }, ...local.filter((a) => a.id !== id)], selectedId: id });
      },

      select: (id) => {
        set({ selectedId: id });
        // The account's default follows the customer's last choice.
        const { remote } = get();
        if (remote?.some((a) => a.id === id && !a.isDefault)) {
          void updateAddress(id, { isDefault: true })
            .then(() => get().loadRemote())
            .catch(() => {});
        }
      },

      remove: async (id) => {
        const { remote, local, selectedId } = get();
        if (remote) {
          await deleteAddress(id);
          await get().loadRemote();
        } else {
          set({ local: local.filter((a) => a.id !== id) });
        }
        if (selectedId === id) {
          const list = get().remote ?? get().local;
          set({ selectedId: (list.find((a) => a.isDefault) ?? list[0])?.id ?? null });
        }
      },

      loadRemote: async () => {
        let rows = await getAddresses();
        if (rows.length === 0 && get().local.length > 0) {
          // First sign-in on this phone: keep what they typed while browsing.
          for (const a of get().local.slice(0, 10)) await addAddress(toBody(a)).catch(() => null);
          rows = await getAddresses();
        }
        const remote = (await Promise.all(rows.map(fromSaved))).filter((a): a is Address => !!a);
        const { selectedId } = get();
        const keep = remote.some((a) => a.id === selectedId);
        set({ remote, selectedId: keep ? selectedId : (remote.find((a) => a.isDefault) ?? remote[0])?.id ?? null });
      },

      dropRemote: () => {
        const { local } = get();
        set({ remote: null, selectedId: local[0]?.id ?? null });
      },
    }),
    {
      name: "efl.addresses",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ local, selectedId }) => ({ local, selectedId }),
      // Version 1 stored the device list as `addresses`.
      version: 2,
      migrate: (persisted: any) => ({ local: persisted?.addresses ?? persisted?.local ?? [], selectedId: persisted?.selectedId ?? null }),
    },
  ),
);

/** The list in force: the account's when signed in, else the device's. */
export function useAddressList(): Address[] {
  return useAddresses((s) => s.remote ?? s.local);
}

export function useSelectedAddress(): Address | null {
  return useAddresses((s) => (s.remote ?? s.local).find((a) => a.id === s.selectedId) ?? null);
}

/** The point shops are searched around: the chosen address, else the pilot centre. */
export function searchPoint(address: Address | null) {
  return address
    ? { lat: address.lat, lng: address.lng, postcode: address.postcode, label: address.line1 }
    : { lat: PILOT_CENTRE.lat, lng: PILOT_CENTRE.lng, postcode: undefined, label: PILOT_CENTRE.label };
}
