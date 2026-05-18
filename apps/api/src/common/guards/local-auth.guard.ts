import { Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

// Used only on POST /auth/login. Triggers LocalStrategy.validate().
// We keep this as a dedicated guard rather than inlining it because
// it makes the controller code self-documenting and easily testable.
@Injectable()
export class LocalAuthGuard extends AuthGuard("local") {}
