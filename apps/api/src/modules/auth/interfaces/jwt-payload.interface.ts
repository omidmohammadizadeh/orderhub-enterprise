import type { UserRole } from "@orderhub/database";

// The exact shape embedded inside every signed access token.
// Keep this lean — it's included in every request header.
export interface JwtPayload {
  sub: string;          // userId (Prisma cuid)
  tenantId: string;     // Always derived from DB at login — never user-supplied
  role: UserRole;
  permissions: string[]; // Fine-grained overrides on top of role defaults
  type: "access";
  iat?: number;
  exp?: number;
}

// Shape decoded from a refresh token JWT (if using JWT refresh tokens).
// We use opaque tokens instead, but this interface documents the contract
// for if/when we switch to signed refresh tokens.
export interface RefreshJwtPayload {
  sub: string;       // userId
  tokenId: string;   // matches RefreshToken.id in DB
  type: "refresh";
  iat?: number;
  exp?: number;
}

// What gets attached to request.user after JwtStrategy validates a token.
// Controllers and guards read from this — never from request.body.tenantId.
export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  role: UserRole;
  permissions: string[];
}
