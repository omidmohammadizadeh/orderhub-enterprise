// Phase AM — Address lookup orchestrator.
//
// All vendor-specific HTTP code lives in providers/*. This service owns:
//   • the registered provider chains (search vs postcode)
//   • the dispatch logic (try first configured provider, fall through on
//     error)
//   • the always-available postcodes.io + manual fallbacks so the POS
//     never breaks just because no paid key is set
//
// To add a new vendor: implement SearchProvider / PostcodeProvider in
// providers/*, then add the class to the chain in address-lookup.module.
// No other code changes.

import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  AddressLookupResult,
  AddressProviderId,
  AddressSuggestion,
  PostcodeProvider,
  ProviderStatus,
  SearchProvider,
} from "./providers/types";

export type {
  AddressLookupResult,
  AddressProviderId,
  AddressSuggestion,
  ProviderStatus,
} from "./providers/types";
/** Legacy alias kept so consumers that imported AddressProvider still build. */
export type AddressProvider = AddressProviderId;

export const SEARCH_PROVIDERS = Symbol("ADDRESS_LOOKUP_SEARCH_PROVIDERS");
export const POSTCODE_PROVIDERS = Symbol("ADDRESS_LOOKUP_POSTCODE_PROVIDERS");

@Injectable()
export class AddressLookupService {
  private readonly logger = new Logger(AddressLookupService.name);

  constructor(
    @Inject(SEARCH_PROVIDERS) private readonly searchChain: SearchProvider[],
    @Inject(POSTCODE_PROVIDERS) private readonly postcodeChain: PostcodeProvider[],
  ) {}

  // ── Diagnostics ──────────────────────────────────────────────────────────

  private firstConfiguredSearch(): SearchProvider | undefined {
    return this.searchChain.find((p) => p.isConfigured());
  }

  private firstConfiguredPostcode(): PostcodeProvider | undefined {
    return this.postcodeChain.find((p) => p.isConfigured());
  }

  describeActiveProvider(): AddressProviderId {
    return this.firstConfiguredSearch()?.id ?? "manual";
  }

  status(): ProviderStatus {
    return {
      searchProvider: this.firstConfiguredSearch()?.id ?? "manual",
      postcodeProvider: this.firstConfiguredPostcode()?.id ?? "manual",
      configured: {
        search: this.searchChain.filter((p) => p.isConfigured()).map((p) => p.id),
        postcode: this.postcodeChain.filter((p) => p.isConfigured()).map((p) => p.id),
      },
    };
  }

  // ── Free-text autocomplete ──────────────────────────────────────────────

  async search(
    query: string,
    country: string = "gb",
    limit: number = 5,
  ): Promise<AddressLookupResult> {
    const trimmed = (query ?? "").trim();
    if (trimmed.length < 2) {
      return { provider: this.describeActiveProvider(), suggestions: [] };
    }
    for (const provider of this.searchChain) {
      if (!provider.isConfigured()) continue;
      try {
        const suggestions = await provider.search(trimmed, country, limit);
        return { provider: provider.id, suggestions };
      } catch (err: any) {
        this.logger.warn(
          `Search provider ${provider.id} failed: ${err.message} — falling through`,
        );
      }
    }
    return { provider: "manual", suggestions: [] };
  }

  /**
   * Two-step providers (Google) return id-only predictions; the operator
   * picks one and the frontend calls this to resolve the full address.
   * Falls through the chain like search() does — the first configured
   * provider that knows how to do getDetails wins.
   */
  async getPlaceDetails(id: string): Promise<AddressSuggestion | null> {
    if (!id) return null;
    for (const provider of this.searchChain) {
      if (!provider.isConfigured() || !provider.getDetails) continue;
      try {
        const result = await provider.getDetails(id);
        if (result) return result;
      } catch (err: any) {
        this.logger.warn(
          `Details provider ${provider.id} failed: ${err.message}`,
        );
      }
    }
    return null;
  }

  // ── Postcode → addresses ────────────────────────────────────────────────

  async searchByPostcode(rawPostcode: string): Promise<AddressLookupResult> {
    const postcode = (rawPostcode ?? "").toUpperCase().replace(/\s+/g, "");
    if (postcode.length < 5) {
      return { provider: this.firstConfiguredPostcode()?.id ?? "manual", suggestions: [] };
    }

    for (const provider of this.postcodeChain) {
      if (!provider.isConfigured()) continue;
      try {
        const suggestions = await provider.searchByPostcode(postcode);
        // Empty list from a paid provider = postcode genuinely has no
        // entries (e.g. brand new build); skip to the next provider so
        // postcodes.io still validates the postcode.
        if (suggestions.length > 0) {
          return { provider: provider.id, suggestions };
        }
      } catch (err: any) {
        this.logger.warn(
          `Postcode provider ${provider.id} failed: ${err.message} — falling through`,
        );
      }
    }

    return { provider: "manual", suggestions: [] };
  }
}
