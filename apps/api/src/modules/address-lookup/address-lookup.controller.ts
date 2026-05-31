import { Controller, Get, Query } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from "@nestjs/swagger";
import { AddressLookupService } from "./address-lookup.service";
import { BillingExempt } from "../../common/guards/billing.guard";
import { Public } from "../../common/decorators/public.decorator";

// Phase AP — every route is @Public so the customer-facing storefront
// (no auth) can also call them. The endpoints proxy to OSM / Google /
// getaddress.io with API-side keys — they never expose tenant data.
@ApiTags("address-lookup")
@ApiBearerAuth()
@BillingExempt()
@Controller({ path: "address-lookup", version: "1" })
export class AddressLookupController {
  constructor(private readonly service: AddressLookupService) {}

  @Public()
  @Get("provider")
  @ApiOperation({ summary: "Which provider is active for autocomplete (legacy)" })
  provider() {
    return { provider: this.service.describeActiveProvider() };
  }

  @Public()
  @Get("status")
  @ApiOperation({ summary: "Active providers for both autocomplete + postcode lookup" })
  status() {
    return this.service.status();
  }

  @Public()
  @Get("postcode")
  @ApiOperation({
    summary: "List all addresses at a UK postcode (getaddress.io / Royal Mail PAF)",
  })
  @ApiQuery({ name: "postcode", required: true })
  postcode(@Query("postcode") postcode: string) {
    return this.service.searchByPostcode(postcode);
  }

  @Public()
  @Get("details")
  @ApiOperation({
    summary: "Resolve a Google Places id to a full structured address",
  })
  @ApiQuery({ name: "id", required: true })
  async details(@Query("id") id: string) {
    const result = await this.service.getPlaceDetails(id);
    return { suggestion: result };
  }

  @Public()
  @Get("search")
  @ApiOperation({ summary: "Autocomplete address search" })
  @ApiQuery({ name: "q", required: true })
  @ApiQuery({ name: "country", required: false })
  @ApiQuery({ name: "limit", required: false })
  search(
    @Query("q") q: string,
    @Query("country") country?: string,
    @Query("limit") limit?: string,
  ) {
    return this.service.search(
      q,
      country ?? "gb",
      limit ? Math.min(parseInt(limit, 10) || 5, 10) : 5,
    );
  }
}
