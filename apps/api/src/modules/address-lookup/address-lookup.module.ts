import { Module } from "@nestjs/common";
import { AddressLookupController } from "./address-lookup.controller";
import {
  AddressLookupService,
  SEARCH_PROVIDERS,
  POSTCODE_PROVIDERS,
  FREETEXT_PROVIDERS,
} from "./address-lookup.service";
import {
  GoogleGeocodeProvider,
  NominatimSearchProvider,
} from "./providers/freetext-providers";
import {
  GoogleSearchProvider,
  MapboxSearchProvider,
} from "./providers/search-providers";
import {
  GetAddressProvider,
  GooglePostcodeProvider,
  PostcodesIoProvider,
  OsmStreetsProvider,
  IdealPostcodesProvider,
  LoqateProvider,
  PostcoderProvider,
  RoyalMailProvider,
} from "./providers/postcode-providers";

// Phase AM — Provider chain wiring.
//
// Order matters: the service walks each chain top-to-bottom and dispatches
// to the first provider whose isConfigured() returns true. To rearrange
// priorities (e.g. prefer Loqate over Ideal Postcodes when both keys are
// present), reorder the array below.
//
// postcodes.io is intentionally LAST among postcode providers because it
// always returns "configured" — having it earlier would short-circuit
// every paid provider. Service-level logic also escalates past it when a
// paid provider returns 0 results, so adding a paid key in front works
// even for postcodes the paid provider doesn't know about.

@Module({
  controllers: [AddressLookupController],
  providers: [
    AddressLookupService,
    // ── Concrete provider classes (DI'd so unit tests can substitute) ──
    GoogleSearchProvider,
    MapboxSearchProvider,
    GoogleGeocodeProvider,
    NominatimSearchProvider,
    GetAddressProvider,
    GooglePostcodeProvider,
    IdealPostcodesProvider,
    LoqateProvider,
    PostcoderProvider,
    RoyalMailProvider,
    OsmStreetsProvider,
    PostcodesIoProvider,
    // ── Ordered chains the service depends on ──
    {
      provide: SEARCH_PROVIDERS,
      useFactory: (g: GoogleSearchProvider, m: MapboxSearchProvider) => [g, m],
      inject: [GoogleSearchProvider, MapboxSearchProvider],
    },
    {
      provide: POSTCODE_PROVIDERS,
      useFactory: (
        ga: GetAddressProvider,
        ip: IdealPostcodesProvider,
        lq: LoqateProvider,
        pc: PostcoderProvider,
        rm: RoyalMailProvider,
        gg: GooglePostcodeProvider,
        osm: OsmStreetsProvider,
        pio: PostcodesIoProvider,
      ) => [ga, ip, lq, pc, rm, gg, osm, pio],
      inject: [
        GetAddressProvider,
        IdealPostcodesProvider,
        LoqateProvider,
        PostcoderProvider,
        RoyalMailProvider,
        GooglePostcodeProvider,
        OsmStreetsProvider,
        PostcodesIoProvider,
      ],
    },
    {
      provide: FREETEXT_PROVIDERS,
      useFactory: (g: GoogleGeocodeProvider, n: NominatimSearchProvider) => [g, n],
      inject: [GoogleGeocodeProvider, NominatimSearchProvider],
    },
  ],
  exports: [AddressLookupService],
})
export class AddressLookupModule {}
