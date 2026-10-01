import "reflect-metadata";
import { PATH_METADATA } from "@nestjs/common/constants";
import { WebhooksController } from "../webhooks.controller";

// The generic receiver must not swallow the dedicated ones.
//
// `webhooks/:platform/:locationId` matches ANY two segments under /webhooks,
// and Express gives a request to the first registered route that matches.
// HubRiseModule imports WebhooksModule, so this controller registers early —
// early enough that a real JET Go courier webhook came back "400 Unknown
// platform: jet-go" while its own handler sat unused. Stuart, Uber Direct,
// Yango, Careem and Stripe were all shadowed the same way and nobody had
// noticed, because no courier webhook had ever actually arrived.

function routePath(method: string): string {
  return Reflect.getMetadata(
    PATH_METADATA,
    (WebhooksController.prototype as any)[method],
  );
}

describe("the generic webhook route's scope", () => {
  const path = routePath("receive");

  it("names the platforms it handles instead of matching anything", () => {
    expect(path).toMatch(/^:platform\(.+\)\/:locationId$/);
  });

  it("covers every platform it can actually dispatch", () => {
    for (const slug of ["uber-eats", "deliveroo", "just-eat", "hubrise"]) {
      expect(path).toContain(slug);
    }
  });

  it.each([
    ["jet-go"],
    ["stuart"],
    ["uber-direct"],
    ["yango"],
    ["careem"],
    ["stripe"],
  ])("leaves %s to its own controller", (slug) => {
    // The regex is an alternation of whole slugs; a dedicated one must not be
    // among them, or its own route never gets the request.
    const alternatives = path.slice(path.indexOf("(") + 1, path.lastIndexOf(")")).split("|");
    expect(alternatives).not.toContain(slug);
  });

  it("matches the slugs it claims and nothing else", () => {
    const alternatives = path.slice(path.indexOf("(") + 1, path.lastIndexOf(")")).split("|");
    const re = new RegExp(`^(${alternatives.join("|")})$`);
    expect(re.test("hubrise")).toBe(true);
    expect(re.test("uber-eats")).toBe(true);
    // "uber-direct" must not be caught by a loose "uber-" style pattern.
    expect(re.test("uber-direct")).toBe(false);
    expect(re.test("jet-go")).toBe(false);
    // ...nor should a prefix of a real slug.
    expect(re.test("hub")).toBe(false);
  });
});
