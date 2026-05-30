import { Controller, Get, Query } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from "@nestjs/swagger";
import { AddressLookupService } from "./address-lookup.service";
import { BillingExempt } from "../../common/guards/billing.guard";

@ApiTags("address-lookup")
@ApiBearerAuth()
@BillingExempt()
@Controller({ path: "address-lookup", version: "1" })
export class AddressLookupController {
  constructor(private readonly service: AddressLookupService) {}

  @Get("provider")
  @ApiOperation({ summary: "Which provider is active (mapbox/google/manual)" })
  provider() {
    return { provider: this.service.describeActiveProvider() };
  }

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
