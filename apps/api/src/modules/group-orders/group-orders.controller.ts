import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { GroupOrdersService } from "./group-orders.service";

// Every route here is PUBLIC: guests join a group order by link, with no
// account. The share token IS the credential for the basket, and a guest's
// browser-scoped `ref` is what limits them to editing their own lines.

@ApiTags("group-orders")
@Controller({ path: "group-orders", version: "1" })
export class GroupOrdersController {
  constructor(private readonly groups: GroupOrdersService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Start a group order and get its share token" })
  create(
    @Body()
    body: {
      tenantId: string;
      locationId: string;
      brandId?: string;
      hostName: string;
      hostCustomerId?: string;
      fulfillmentType?: string;
      paymentMode?: string;
    },
  ) {
    return this.groups.create(body);
  }

  @Public()
  @Get(":token")
  @ApiOperation({ summary: "The shared basket, its lines and per-person totals" })
  get(@Param("token") token: string) {
    return this.groups.getByToken(token);
  }

  @Public()
  @Post(":token/items")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Add one of your own lines to the basket" })
  addItem(
    @Param("token") token: string,
    @Body()
    body: {
      addedByName: string;
      addedByRef: string;
      cartItem: unknown;
      quantity: number;
      lineTotal: number;
    },
  ) {
    return this.groups.addItem(token, body);
  }

  @Public()
  @Delete(":token/items/:itemId")
  @ApiOperation({ summary: "Remove a line you added" })
  removeItem(
    @Param("token") token: string,
    @Param("itemId") itemId: string,
    @Query("ref") ref: string,
  ) {
    return this.groups.removeItem(token, itemId, ref);
  }

  @Public()
  @Post(":token/lock")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Host closes the basket so the total can't move" })
  lock(@Param("token") token: string) {
    return this.groups.lock(token);
  }

  @Public()
  @Post(":token/unlock")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Host reopens a locked basket" })
  unlock(@Param("token") token: string) {
    return this.groups.unlock(token);
  }

  @Public()
  @Post(":token/place")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Host places the locked basket as a real order" })
  place(
    @Param("token") token: string,
    @Body()
    body: {
      customerInfo: { name: string; phone?: string; email?: string };
      deliveryAddress?: {
        line1: string;
        line2?: string;
        city: string;
        postcode: string;
        country?: string;
      };
      deliveryFee?: number;
      specialInstructions?: string;
      paymentMethod?: string;
      paymentStatus?: string;
      idempotencyKey?: string;
    },
  ) {
    return this.groups.place(token, body);
  }

  @Public()
  @Post(":token/cancel")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Abandon a group order" })
  cancel(@Param("token") token: string) {
    return this.groups.cancel(token);
  }
}
