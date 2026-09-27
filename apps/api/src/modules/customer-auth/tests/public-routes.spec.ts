import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";
import { CustomerAuthController } from "../customer-auth.controller";

// Every customer-auth route is reached by a storefront shopper, never by a
// logged-in staff member, so each one must opt out of the global staff JWT
// guard. A decorator that drifted onto a helper method once left login
// behind that guard: every email/password sign-in answered 401 for weeks.

const ROUTES = ["signup", "verify", "login", "me", "logout", "listOrders", "google", "googleCallback"] as const;

describe("customer-auth routes are public", () => {
  const proto = CustomerAuthController.prototype as any;
  const handlers = Object.getOwnPropertyNames(proto).filter(
    (k) => k !== "constructor" && Reflect.getMetadata("path", proto[k]) !== undefined,
  );

  it("finds the routes it is guarding", () => {
    expect(handlers.length).toBeGreaterThanOrEqual(ROUTES.length - 2);
  });

  it.each(handlers)("%s is @Public()", (name) => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto[name])).toBe(true);
  });

  it("login in particular", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.login)).toBe(true);
  });
});
