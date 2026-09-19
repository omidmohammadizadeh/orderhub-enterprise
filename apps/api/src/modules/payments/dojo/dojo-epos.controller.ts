import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "../../../common/decorators/public.decorator";
import { DojoService } from "./dojo.service";
import { DojoEposService, EposContext, EposError } from "./dojo-epos.service";

// Pay at Table: the endpoints DOJO calls on us (their "EPOS Data API (REST)").
//
// We register `${API_PUBLIC_URL}/v1/dojo/epos/<locationId>` as the base URL,
// one per location, each with its own Basic-auth credentials — so the path
// says which shop and the password proves it's Dojo. @Public skips our JWT
// guard; checkEposAuth is the auth.
//
// Two routes are doubled up on purpose. Dojo's OpenAPI spec says search is
// POST /v1/orders/search and POST /v1/tables/search, but their prose docs say
// POST /v1/orders and POST /v1/tables. We don't register CreateOrder, so
// POST /v1/orders is unambiguous and serving both costs nothing — whichever
// one the real machines use, it works.
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller({ path: "dojo/epos/:locationId/v1", version: "1" })
export class DojoEposController {
  constructor(
    private readonly dojo: DojoService,
    private readonly epos: DojoEposService,
  ) {}

  private async ctx(locationId: string, authorization?: string): Promise<EposContext> {
    const auth = await this.dojo.checkEposAuth(locationId, authorization);
    if (!auth) throw new EposError("InvalidRequest", "Unauthorised", HttpStatus.UNAUTHORIZED);
    return auth as EposContext;
  }

  @Get("areas")
  async areas(@Param("locationId") id: string, @Headers("authorization") a?: string) {
    return this.epos.listAreas(await this.ctx(id, a));
  }

  @Post(["tables/search", "tables"])
  @HttpCode(HttpStatus.OK)
  async tables(@Param("locationId") id: string, @Body() body: any, @Headers("authorization") a?: string) {
    return this.epos.searchTables(await this.ctx(id, a), body ?? {});
  }

  @Post(["orders/search", "orders"])
  @HttpCode(HttpStatus.OK)
  async orders(@Param("locationId") id: string, @Body() body: any, @Headers("authorization") a?: string) {
    return this.epos.searchOrders(await this.ctx(id, a), body ?? {});
  }

  @Get("orders/:orderId")
  async order(
    @Param("locationId") id: string,
    @Param("orderId") orderId: string,
    @Headers("authorization") a?: string,
  ) {
    return this.epos.getOrder(await this.ctx(id, a), orderId);
  }

  @Get("orders/:orderId/bill")
  async bill(
    @Param("locationId") id: string,
    @Param("orderId") orderId: string,
    @Headers("authorization") a?: string,
  ) {
    return this.epos.getBill(await this.ctx(id, a), orderId);
  }

  @Post("orders/:orderId/lock")
  @HttpCode(HttpStatus.OK)
  async lock(
    @Param("locationId") id: string,
    @Param("orderId") orderId: string,
    @Body() body: any,
    @Headers("authorization") a?: string,
  ) {
    return this.epos.createLock(await this.ctx(id, a), orderId, body ?? {});
  }

  @Put("orders/:orderId/locks/:lockId")
  async extendLock(
    @Param("locationId") id: string,
    @Param("orderId") orderId: string,
    @Param("lockId") lockId: string,
    @Body() body: any,
    @Headers("authorization") a?: string,
  ) {
    return this.epos.extendLock(await this.ctx(id, a), orderId, lockId, body ?? {});
  }

  @Delete("orders/:orderId/locks/:lockId")
  async unlock(
    @Param("locationId") id: string,
    @Param("orderId") orderId: string,
    @Param("lockId") lockId: string,
    @Headers("authorization") a?: string,
  ) {
    return this.epos.deleteLock(await this.ctx(id, a), orderId, lockId);
  }

  @Post("orders/:orderId/record-payment")
  @HttpCode(HttpStatus.OK)
  async recordPayment(
    @Param("locationId") id: string,
    @Param("orderId") orderId: string,
    @Body() body: any,
    @Headers("authorization") a?: string,
    @Headers("waiter-id") waiterId?: string,
    @Headers("device-id") deviceId?: string,
  ) {
    return this.epos.recordPayment(await this.ctx(id, a), orderId, body ?? {}, { waiterId, deviceId });
  }
}
