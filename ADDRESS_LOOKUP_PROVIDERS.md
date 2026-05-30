# Address Lookup Providers

The POS uses two independent provider abstractions:

* **Search provider** — free-text autocomplete (operator types "1 old kent road")
* **Postcode provider** — UK postcode → list of houses (operator types "NE10 8YH")

Different vendors cover different capabilities. The system composes a chain at boot time and dispatches to the first configured provider. **The POS never breaks** if no paid provider is configured — manual entry + the free postcodes.io fallback are always available.

## Currently wired

### Search (autocomplete)

| Provider | Env var | Cost | Notes |
|---|---|---|---|
| **Google Places** | `GOOGLE_MAPS_API_KEY` | $200/month Google Cloud credit covers ~11k sessions | Recommended. Returns id-only predictions; service fetches details on pick. |
| **Mapbox** | `MAPBOX_ACCESS_TOKEN` | Free 100k requests/month, then $0.75/1k | One-shot — fully-structured suggestions inline. Fallback when Google not set. |
| Manual | — | Free | Always available. No suggestions; operator types the address. |

### Postcode

| Provider | Env var | Cost | Notes |
|---|---|---|---|
| **getaddress.io** | `GETADDRESS_API_KEY` | Free tier ~20/day, then £0.005/lookup | Royal Mail PAF. Full per-house list. Recommended for production. |
| **Nominatim (OSM)** | — | Free, no key (1 req/sec policy) | Street names + town + postcode. Operator types the house number. Disable with `ADDRESS_LOOKUP_DISABLE_NOMINATIM=true`. |
| **postcodes.io** | — | Free, no key | Town + postcode only. Last-resort fallback when Nominatim is down or rate-limited. |
| Manual | — | Free | Always available. |

## Stubbed (drop-in ready for next phase)

These adapters live in `apps/api/src/modules/address-lookup/providers/postcode-providers.ts` with `isConfigured()` wired against the env var below. Each one throws a clear "not implemented" error from `searchByPostcode` so the chain falls through cleanly even if the env var is accidentally set during the integration work.

| Provider | Env var | Notes |
|---|---|---|
| Ideal Postcodes | `IDEAL_POSTCODES_API_KEY` | PAF + Multiple Residence. £0.025/lookup. |
| Loqate (PCA Predict) | `LOQATE_API_KEY` | Two-step Find + Retrieve. Enterprise pricing. |
| Postcoder | `POSTCODER_API_KEY` | Flat ~£35/month. |
| Royal Mail PAF direct | `ROYAL_MAIL_PAF_KEY` | Direct PAF licence. Only sensible at very high volume. |

## Chain ordering

Configured in `address-lookup.module.ts`:

```
SEARCH_PROVIDERS:    [Google, Mapbox]
POSTCODE_PROVIDERS:  [GetAddress, IdealPostcodes, Loqate, Postcoder, RoyalMail, Nominatim, PostcodesIo]
```

The service iterates each chain top-to-bottom and dispatches to the **first provider whose `isConfigured()` returns true**.

`PostcodesIoProvider.isConfigured()` always returns `true` (no key required) — it sits at the END of the chain on purpose so paid providers always win when their key is set.

The postcode service also **falls through on empty results** from a paid provider (not just on errors) — so a postcode the paid provider doesn't know about still gets the postcodes.io town + coords fallback.

## Adding a new provider

1. Implement `SearchProvider` or `PostcodeProvider` in `providers/search-providers.ts` or `providers/postcode-providers.ts`. The interfaces live in `providers/types.ts`.
2. Register the class in `address-lookup.module.ts`:
   * Add to the `providers: [...]` array.
   * Add it to the relevant `useFactory` chain in the right position.
3. (Optional) bump the doc table above.

That's the whole change. The controller, web client, cart panel, and tests don't care which vendor is in the chain.

## Diagnostics

`GET /v1/address-lookup/status` returns:

```json
{
  "searchProvider":    "google" | "mapbox" | "manual",
  "postcodeProvider":  "getaddress" | "postcodes_io" | "manual" | ...,
  "configured": {
    "search":   ["google"],
    "postcode": ["postcodes_io"]
  }
}
```

The `configured` arrays list every provider whose env vars are set, in chain order. Useful for confirming a new env var landed without restarting from scratch.
