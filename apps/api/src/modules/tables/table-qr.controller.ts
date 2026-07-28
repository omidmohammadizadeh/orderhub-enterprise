import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { TableQrService, type QrOrderItem } from "./table-qr.service";
import { Public } from "../../common/decorators/public.decorator";

// Guest-facing QR-at-table routes. Every one is @Public() and keyed
// ONLY by the table's rotatable token — there is no login on a diner's
// phone. Kept in its own controller (rather than bolted onto
// TablesController) so the public surface is obvious at a glance and
// can't accidentally inherit a staff route.
@ApiTags("table-qr")
@Controller({ path: "table-qr", version: "1" })
export class TableQrController {
  constructor(private readonly qr: TableQrService) {}

  @Get(":token")
  @Public()
  @ApiOperation({ summary: "Resolve a scanned table QR code" })
  resolve(@Param("token") token: string) {
    return this.qr.resolve(token);
  }

  @Get(":token/tab")
  @Public()
  @ApiOperation({ summary: "What's on my table so far" })
  myTab(@Param("token") token: string) {
    return this.qr.myTab(token);
  }

  @Post(":token/order")
  @Public()
  @ApiOperation({ summary: "Send a round to the kitchen from a guest's phone" })
  order(
    @Param("token") token: string,
    @Body()
    body: {
      items: QrOrderItem[];
      customerName?: string;
      notes?: string | null;
      requestId?: string;
    },
  ) {
    return this.qr.placeOrder(token, body);
  }
}
