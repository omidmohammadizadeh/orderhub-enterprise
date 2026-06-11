// Phase AP-AUTH — JWT strategy for customer-facing routes.
//
// Distinct from the staff JwtStrategy via:
//   * Passport name "customer-jwt"
//   * aud claim verification (CUSTOMER_JWT_AUDIENCE)
// so a customer JWT cannot be replayed against staff routes and vice
// versa, even though both are signed with the same JWT_SECRET.

import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, ExtractJwt } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import {
  CustomerAuthService,
  CUSTOMER_JWT_AUDIENCE,
} from "./customer-auth.service";

@Injectable()
export class CustomerJwtStrategy extends PassportStrategy(
  Strategy,
  "customer-jwt",
) {
  constructor(
    config: ConfigService,
    private readonly customerAuth: CustomerAuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>("JWT_SECRET") ?? "dev-secret",
      audience: CUSTOMER_JWT_AUDIENCE,
    });
  }

  // Passport hands us the verified payload; we hydrate the Customer
  // row so request.user is the full record.
  async validate(payload: any) {
    if (!payload?.sub) throw new UnauthorizedException();
    const customer = await this.customerAuth.getById(payload.sub);
    if (!customer) throw new UnauthorizedException();
    return customer;
  }
}
