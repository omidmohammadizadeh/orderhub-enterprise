import { Body, Controller, Delete, Get, Headers, HttpCode, Logger, Param, Post, Query, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Response } from "express";
import { Public } from "../../../common/decorators/public.decorator";
import { WalkInLoyaltyService } from "./walk-in-loyalty.service";

// Apple's PassKit web service, which Wallet on the customer's iPhone calls by
// itself. The paths are Apple's, appended to the pass's webServiceURL
// (`…/api/v1/loyalty/passkit`), hence the second "v1". The credential is the
// pass's authenticationToken, sent as "Authorization: ApplePass <token>".
// https://developer.apple.com/documentation/walletpasses/adding_a_web_service_to_update_passes
@ApiExcludeController()
@Controller({ path: "loyalty/passkit", version: "1" })
export class PassKitController {
  private readonly logger = new Logger("PassKit");

  constructor(private readonly walkIn: WalkInLoyaltyService) {}

  @Public()
  @Post("v1/devices/:device/registrations/:passType/:serial")
  async register(
    @Param("device") device: string,
    @Param("passType") passType: string,
    @Param("serial") serial: string,
    @Headers("authorization") auth: string | undefined,
    @Body() body: { pushToken?: string },
    @Res() res: Response,
  ) {
    const { created } = await this.walkIn.registerDevice(device, passType, serial, auth, body?.pushToken ?? "");
    res.status(created ? 201 : 200).end();
  }

  @Public()
  @Delete("v1/devices/:device/registrations/:passType/:serial")
  @HttpCode(200)
  async unregister(
    @Param("device") device: string,
    @Param("passType") passType: string,
    @Param("serial") serial: string,
    @Headers("authorization") auth: string | undefined,
  ) {
    await this.walkIn.unregisterDevice(device, passType, serial, auth);
    return {};
  }

  @Public()
  @Get("v1/devices/:device/registrations/:passType")
  async changed(
    @Param("device") device: string,
    @Param("passType") passType: string,
    @Query("passesUpdatedSince") since: string | undefined,
    @Res() res: Response,
  ) {
    const result = await this.walkIn.changedSerials(device, passType, since);
    if (!result) {
      res.status(204).end();
      return;
    }
    res.status(200).json(result);
  }

  @Public()
  @Get("v1/passes/:passType/:serial")
  async latest(
    @Param("passType") passType: string,
    @Param("serial") serial: string,
    @Headers("authorization") auth: string | undefined,
    @Headers("if-modified-since") ifModifiedSince: string | undefined,
    @Res() res: Response,
  ) {
    const { buffer, lastModified } = await this.walkIn.latestApplePass(passType, serial, auth);
    // HTTP dates are whole seconds.
    const modified = new Date(Math.floor(lastModified.getTime() / 1000) * 1000);
    if (ifModifiedSince && new Date(ifModifiedSince) >= modified) {
      res.status(304).end();
      return;
    }
    res
      .status(200)
      .set({
        "Content-Type": "application/vnd.apple.pkpass",
        "Last-Modified": modified.toUTCString(),
        "Cache-Control": "no-store",
      })
      .send(buffer);
  }

  @Public()
  @Post("v1/log")
  @HttpCode(200)
  log(@Body() body: { logs?: string[] }) {
    for (const line of (body?.logs ?? []).slice(0, 20)) this.logger.warn(`Wallet: ${String(line).slice(0, 500)}`);
    return {};
  }
}
