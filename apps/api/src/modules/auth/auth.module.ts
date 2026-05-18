import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ConfigModule, ConfigService } from "@nestjs/config";

import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

// Services
import { TokenService } from "./services/token.service";
import { PasswordService } from "./services/password.service";
import { OAuthService } from "./services/oauth.service";
import { AuditLogService } from "./services/audit-log.service";

// Strategies
import { LocalStrategy } from "./strategies/local.strategy";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { GoogleStrategy } from "./strategies/oauth/google.strategy";
// AppleStrategy is registered but does nothing until env vars are set
import { AppleStrategy } from "./strategies/oauth/apple.strategy";

@Module({
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: "jwt" }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>("JWT_SECRET"),
        signOptions: {
          expiresIn: config.get("JWT_ACCESS_TTL", "15m"),
          issuer: "orderhub",
          audience: "orderhub-api",
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    // Core
    AuthService,

    // Sub-services (single-responsibility)
    TokenService,
    PasswordService,
    OAuthService,
    AuditLogService,

    // Passport strategies
    LocalStrategy,
    JwtStrategy,
    GoogleStrategy,
    AppleStrategy,
  ],
  // TokenService and AuditLogService are used by other modules
  // (e.g. future ApiKeyModule, WebhooksModule)
  exports: [AuthService, TokenService, AuditLogService, JwtModule],
})
export class AuthModule {}
