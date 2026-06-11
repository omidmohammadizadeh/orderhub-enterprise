// Phase AP-AUTH — Customer auth module.
//
// Imports AuthModule purely to get PasswordService + JwtModule (both
// exported from there); no staff-auth surface is reused.

import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "../auth/auth.module";
import { CustomerAuthController } from "./customer-auth.controller";
import { CustomerAuthService } from "./customer-auth.service";
import { CustomerJwtStrategy } from "./customer-jwt.strategy";

@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [CustomerAuthController],
  providers: [CustomerAuthService, CustomerJwtStrategy],
  exports: [CustomerAuthService],
})
export class CustomerAuthModule {}
