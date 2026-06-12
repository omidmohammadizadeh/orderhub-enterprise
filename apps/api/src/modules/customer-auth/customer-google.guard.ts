// Phase AP-AUTH increment 2b — custom Passport guard for the
// customer Google OAuth flow.
//
// The base AuthGuard("customer-google") intercepts the request and
// redirects to Google before our controller body runs. That makes it
// impossible to attach a per-request `state` parameter to the OAuth
// URL from inside the controller.
//
// NestJS provides one hook for this: override getAuthenticateOptions
// on a guard subclass. Whatever we return here is merged into the
// Passport-OAuth2 strategy's authenticate() call, so we can pull
// the storeSlug off the incoming query string and surface it as the
// OAuth `state` parameter. Google echoes that state back to our
// callback URL unchanged, which is exactly the round-trip we need to
// know which storefront to redirect the customer to after they
// sign in.

import { ExecutionContext, Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import type { Request } from "express";

@Injectable()
export class CustomerGoogleGuard extends AuthGuard("customer-google") {
  override getAuthenticateOptions(
    context: ExecutionContext,
  ): Record<string, unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    // Accept either ?state= or ?storeSlug= — the storefront LoginModal
    // sends ?state=, but ?storeSlug= is a friendlier alias for direct
    // testing via curl/browser.
    const slug =
      (req.query.state as string | undefined) ||
      (req.query.storeSlug as string | undefined) ||
      "";
    return { state: slug };
  }
}
