// Phase AP-AUTH — public customer auth routes.
//
// All routes are @Public() (opt out of staff JwtAuthGuard); the /me
// endpoint uses CustomerJwtGuard to identify the caller.

import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { CustomerAuthService } from "./customer-auth.service";
import { CustomerSignupDto } from "./dto/signup.dto";
import { CustomerLoginDto } from "./dto/login.dto";
import { CustomerJwtGuard, CurrentCustomer } from "./customer.decorator";

@ApiTags("Customer Auth")
@Controller("customer-auth")
export class CustomerAuthController {
  constructor(private readonly customerAuth: CustomerAuthService) {}

  @Public()
  @Post("signup")
  @ApiOperation({ summary: "Customer email/password signup" })
  signup(@Body() dto: CustomerSignupDto) {
    return this.customerAuth.signup(dto);
  }

  @Public()
  @Get("verify")
  @ApiOperation({ summary: "Verify email via signed token link" })
  verify(@Query("token") token: string) {
    return this.customerAuth.verifyEmail(token);
  }

  @Public()
  @Post("login")
  @ApiOperation({ summary: "Customer email/password login" })
  login(@Body() dto: CustomerLoginDto) {
    return this.customerAuth.login(dto);
  }

  @UseGuards(CustomerJwtGuard)
  @Get("me")
  @ApiOperation({ summary: "Current customer (from JWT)" })
  me(@CurrentCustomer() customer: any) {
    return customer;
  }
}
