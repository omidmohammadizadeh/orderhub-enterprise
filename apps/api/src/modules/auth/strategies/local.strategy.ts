import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy } from "passport-local";
import { AuthService } from "../auth.service";

// Used only by the /auth/login endpoint (LocalAuthGuard).
// Passport calls validate() with the extracted credentials.
// On success, Passport attaches the return value to request.user.
@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy, "local") {
  constructor(private readonly authService: AuthService) {
    super({ usernameField: "email" }); // Our login form uses "email" not "username"
  }

  async validate(email: string, password: string) {
    const user = await this.authService.validateCredentials(email, password);
    if (!user) {
      throw new UnauthorizedException("Invalid email or password");
    }
    return user;
  }
}
