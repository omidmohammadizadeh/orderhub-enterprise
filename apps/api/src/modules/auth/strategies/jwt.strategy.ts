import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import type { JwtPayload, AuthenticatedUser } from "../interfaces/jwt-payload.interface";

// Extracts JWT from Bearer header OR httpOnly cookie (for browser clients).
// The cookie extractor is a fallback — mobile apps and API consumers
// use the Authorization header.
function cookieOrHeaderExtractor(req: Request): string | null {
  const fromHeader = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
  if (fromHeader) return fromHeader;

  const fromCookie = req.cookies?.["access_token"] as string | undefined;
  return fromCookie ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: cookieOrHeaderExtractor,
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>("JWT_SECRET"),
    });
  }

  // Called by Passport after signature verification.
  // The return value is attached to request.user.
  // We keep this lean — tenantId and role are already in the JWT;
  // no DB round-trip needed for standard API requests.
  validate(payload: JwtPayload): AuthenticatedUser {
    if (payload.type !== "access") {
      throw new UnauthorizedException("Invalid token type");
    }
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
      permissions: payload.permissions,
    };
  }
}
