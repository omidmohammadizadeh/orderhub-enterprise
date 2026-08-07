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
  CUSTOMER_TOKEN_COOKIE,
} from "./customer-auth.service";

/**
 * Read the session cookie without pulling in cookie-parser.
 *
 * One dependency avoided on a deploy that has a history of build failures,
 * for a header that is trivially parsed. Returns null on anything unexpected
 * so a malformed Cookie header degrades to "not signed in" rather than a 500.
 */
export function fromSessionCookie(req: any): string | null {
  const raw = req?.headers?.cookie;
  if (typeof raw !== "string") return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== CUSTOMER_TOKEN_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value) || null;
    } catch {
      return value || null;
    }
  }
  return null;
}

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
      // Bearer first — the storefront sends it when localStorage still has
      // the token, and it is what every existing caller uses. The cookie is
      // the fallback for the case this whole change exists for: a browser
      // that threw localStorage away but kept the cookie.
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        fromSessionCookie,
      ]),
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
