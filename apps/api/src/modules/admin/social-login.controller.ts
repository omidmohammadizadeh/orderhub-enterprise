import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsArray, IsBoolean, IsOptional, IsString } from "class-validator";
import { SocialLoginService } from "./social-login.service";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

class SetSocialLoginDto {
  @IsBoolean() iosApple!: boolean;
  @IsBoolean() iosGoogle!: boolean;
  @IsBoolean() androidGoogle!: boolean;
}

class SetStoreDto {
  @IsBoolean() promote!: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) shopIds?: string[];
  @IsOptional() @IsString() androidPackage?: string | null;
  @IsOptional() @IsString() iosAppStoreId?: string | null;
}

// Admin Dashboard → Social login. PLATFORM_ADMIN only: whether an app ships
// with social sign-in is part of how WE submit it to the stores.
@ApiTags("Admin")
@ApiBearerAuth()
@Roles("PLATFORM_ADMIN")
@Controller({ path: "admin/social-login", version: "1" })
export class SocialLoginController {
  constructor(private readonly socialLogin: SocialLoginService) {}

  @Get()
  @ApiOperation({ summary: "Every brand, with the sign-in buttons its app shows" })
  list() {
    return this.socialLogin.list();
  }

  @Put(":brandId")
  @ApiOperation({ summary: "Choose the sign-in buttons one brand's app shows on iOS and Android" })
  set(
    @Param("brandId") brandId: string,
    @Body() dto: SetSocialLoginDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.socialLogin.set(
      brandId,
      { ios: { apple: dto.iosApple, google: dto.iosGoogle }, android: { google: dto.androidGoogle } },
      user.userId,
    );
  }

  @Put(":brandId/ios-onboarding")
  @ApiOperation({ summary: "A restaurant's Apple developer details and iOS onboarding progress" })
  setIosOnboarding(
    @Param("brandId") brandId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.socialLogin.setIosOnboarding(brandId, body, user.userId);
  }

  @Get(":brandId/shops")
  @ApiOperation({ summary: "The business's shops, and which ones this brand's app sells from" })
  shops(@Param("brandId") brandId: string) {
    return this.socialLogin.shopsFor(brandId);
  }

  @Put(":brandId/store")
  @ApiOperation({ summary: "A brand app's store listing, and whether customers are sent to it" })
  setStore(@Param("brandId") brandId: string, @Body() dto: SetStoreDto, @CurrentUser() user: AuthenticatedUser) {
    return this.socialLogin.setStore(brandId, dto, user.userId);
  }
}

// Read by the restaurant app at launch. Its own controller so no
// `brands/:brandId` handler can swallow the path.
@ApiTags("Public")
@Controller({ path: "public/customer-app", version: "1" })
export class PublicSocialLoginController {
  constructor(private readonly socialLogin: SocialLoginService) {}

  @Public()
  @Get(":brandId/social-login")
  @ApiOperation({ summary: "Sign-in buttons a brand's app may show, per platform" })
  get(@Param("brandId") brandId: string) {
    return this.socialLogin.forApp(brandId);
  }
}
