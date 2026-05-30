// Phase AM — Address lookup provider abstraction.
//
// The POS needs two distinct capabilities:
//
//   1. Free-text autocomplete       (user types "1 old kent road" → suggestions)
//   2. Postcode → addresses         (user types "NE10 8YH"          → list of houses)
//
// They are sourced from different vendors with different cost models,
// so we keep them as separate provider interfaces. A vendor can implement
// one, the other, or both. The service composes a chain at construction
// time based on env var presence and dispatches to the first capable
// provider; if no provider is configured the POS still works with manual
// entry.
//
// To add a new vendor (Ideal Postcodes, Loqate, Postcoder, Royal Mail
// direct, etc.):
//
//   1. Drop a new class in providers/postcode-providers.ts or
//      providers/search-providers.ts.
//   2. Implement the interface — `isConfigured()` returns true when the
//      relevant env vars are present, the lookup method returns
//      AddressSuggestion[].
//   3. Register the class in address-lookup.module.ts → providers chain.
//
// No other code changes — the controller / cart panel / docs stay the same.

export type AddressProviderId =
  | "mapbox"
  | "google"
  | "getaddress"
  | "postcodes_io"
  | "ideal_postcodes"
  | "loqate"
  | "postcoder"
  | "royal_mail"
  | "manual";

export interface AddressSuggestion {
  id: string;
  label: string; // human-readable for the UI list
  line1: string;
  line2?: string;
  city?: string;
  postcode?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  provider: AddressProviderId;
}

export interface AddressLookupResult {
  provider: AddressProviderId;
  suggestions: AddressSuggestion[];
}

/**
 * Free-text autocomplete provider. Implementations: Google Places,
 * Mapbox. Adding Loqate Autocomplete or Ideal Postcodes Address Finder
 * later means dropping a new class that returns AddressSuggestion[] from
 * a query string.
 */
export interface SearchProvider {
  readonly id: AddressProviderId;
  isConfigured(): boolean;
  search(query: string, country: string, limit: number): Promise<AddressSuggestion[]>;
  /**
   * Optional second step for providers that return id-only predictions
   * (Google Places). Returning null = the prediction already had a
   * complete address.
   */
  getDetails?(id: string): Promise<AddressSuggestion | null>;
}

/**
 * UK postcode-to-houses provider. Implementations: getaddress.io (paid),
 * postcodes.io (free, town only). Adding Ideal Postcodes / Loqate /
 * Postcoder / Royal Mail PAF direct = a new class.
 */
export interface PostcodeProvider {
  readonly id: AddressProviderId;
  isConfigured(): boolean;
  searchByPostcode(postcode: string): Promise<AddressSuggestion[]>;
}

export interface ProviderStatus {
  searchProvider: AddressProviderId;
  postcodeProvider: AddressProviderId;
  /** Ordered list of configured providers — useful for diagnostics. */
  configured: {
    search: AddressProviderId[];
    postcode: AddressProviderId[];
  };
}
