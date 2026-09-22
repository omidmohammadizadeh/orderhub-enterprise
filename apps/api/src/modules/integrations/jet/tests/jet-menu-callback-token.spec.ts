import { JetLifecycleController } from "../jet-lifecycle.controller";
import { JetMenuPublishService } from "../jet-menu-publish.service";

// JET's menu-ingest callback arrives WITHOUT our inbound API key.
//
// Real log, 22 Sep 2026 07:16:47 — six seconds after a 202'd publish:
//   JET menu-callback webhook REJECTED: neither Authorization nor X-API-Key
//   matched JET_INBOUND_API_KEY
//   POST /api/v1/integrations/jet/menu-callback 401
//
// The callback URL is one WE put in each publish, so JET calls it bare. Every
// menu outcome was being thrown away — and with it the post-ingest re-86,
// which only runs on that callback.
//
// Each publish now carries a random one-time token in its callback_url. The
// callback is accepted with EITHER the API key OR the token issued for that
// restaurant; anything else is still a 401.

describe("publishMenu puts a per-publish token on callback_url", () => {
  function makePublish() {
    const request = jest.fn().mockResolvedValue(null);
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      menu: {
        findFirst: jest.fn(async () => ({ id: "menu-1", name: "M", description: null, brandId: "b1", locationId: "l1" })),
        update: jest.fn().mockResolvedValue({}),
      },
      brandPlatformConnection: {
        findFirst: jest.fn(async () => ({ id: "conn-1", locationId: "l1", externalStoreId: "440823", metadata: {} })),
        findUnique: jest.fn(async () => ({ metadata: {} })),
        update,
      },
      menuCategory: {
        findMany: jest.fn(async () => [
          { id: "c1", name: "Burgers", description: "", items: [{ isVisible: true, priceOverride: null, item: { id: "i1", name: "Burger", description: "", basePrice: 10, plu: "B1", imageUrl: null, hasMultipleSkus: false } }] },
        ]),
      },
      modifierGroupOnItem: { findMany: jest.fn(async () => []) },
      modifierGroup: { findMany: jest.fn(async () => []) },
      location: { findUnique: jest.fn(async () => ({ openingHours: { monday: [{ from: "09:00", to: "22:00" }] } })) },
      brand: { findUnique: jest.fn(async () => ({ openingHours: null })) },
    } as any;
    const service = new JetMenuPublishService(
      prisma,
      { request } as any,
      { get: () => "https://api.example.com" } as any,
      { forBrandChannel: jest.fn(async () => null) } as any,
      { record: jest.fn() } as any,
    );
    return { service, request, update };
  }

  it("sends a callback_url carrying a long random token, and stores it", async () => {
    const { service, request, update } = makePublish();
    await service.publishMenu({ tenantId: "t1", menuId: "menu-1" });
    const url = new URL(request.mock.calls[0][2].body.callback_url);
    const token = url.searchParams.get("token")!;
    expect(url.pathname).toContain("/integrations/jet/menu-callback");
    expect(token).toMatch(/^[a-f0-9]{48}$/);
    const stored = update.mock.calls.at(-1)[0].data.metadata.jetMenuPublish;
    expect(stored.callbackTokens).toContain(token);
  });

  it("issues a different token on every publish", async () => {
    const a = makePublish();
    await a.service.publishMenu({ tenantId: "t1", menuId: "menu-1" });
    const b = makePublish();
    await b.service.publishMenu({ tenantId: "t1", menuId: "menu-1" });
    const t = (m: any) => new URL(m.request.mock.calls[0][2].body.callback_url).searchParams.get("token");
    expect(t(a)).not.toBe(t(b));
  });
});

describe("JetMenuPublishService.verifyCallbackToken", () => {
  function svc(metadata: any) {
    const prisma = {
      brandPlatformConnection: { findFirst: jest.fn(async () => (metadata ? { metadata } : null)) },
    } as any;
    return new JetMenuPublishService(prisma, {} as any, { get: () => "" } as any, {} as any);
  }
  const T = "a".repeat(48);

  it("accepts a token issued for that restaurant", async () => {
    await expect(svc({ jetMenuPublish: { callbackTokens: ["x".repeat(48), T] } }).verifyCallbackToken("440823", T)).resolves.toBe(true);
  });
  it("rejects a wrong, empty or unknown-restaurant token", async () => {
    const s = svc({ jetMenuPublish: { callbackTokens: [T] } });
    await expect(s.verifyCallbackToken("440823", "b".repeat(48))).resolves.toBe(false);
    await expect(s.verifyCallbackToken("440823", "")).resolves.toBe(false);
    await expect(s.verifyCallbackToken("", T)).resolves.toBe(false);
    await expect(svc(null).verifyCallbackToken("440823", T)).resolves.toBe(false);
  });
});

describe("POST menu-callback authentication", () => {
  function makeController(opts: { keyOk: boolean; tokenOk: boolean }) {
    const prisma = {
      webhookEvent: { create: jest.fn(async ({ data }: any) => data), update: jest.fn(async () => ({})) },
    } as any;
    const client = { verifyInboundApiKey: jest.fn(() => opts.keyOk) } as any;
    const menu = {
      handleMenuCallback: jest.fn().mockResolvedValue({ handled: true }),
      verifyCallbackToken: jest.fn().mockResolvedValue(opts.tokenOk),
    } as any;
    const controller = new JetLifecycleController(prisma, client, {} as any, menu, {} as any);
    return { controller, menu };
  }
  const body = { restaurant: "440823", ingestion_succeeded: true };

  it("accepts JET's bare callback when the token matches", async () => {
    const { controller, menu } = makeController({ keyOk: false, tokenOk: true });
    await controller.menuCallback(body, undefined as any, undefined, "tok");
    expect(menu.verifyCallbackToken).toHaveBeenCalledWith("440823", "tok");
    expect(menu.handleMenuCallback).toHaveBeenCalledWith(body);
  });

  it("still accepts the API key", async () => {
    const { controller, menu } = makeController({ keyOk: true, tokenOk: false });
    await controller.menuCallback(body, "key", undefined, undefined);
    expect(menu.handleMenuCallback).toHaveBeenCalled();
  });

  it("401s with neither", async () => {
    const { controller, menu } = makeController({ keyOk: false, tokenOk: false });
    await expect(controller.menuCallback(body, undefined as any, undefined, "nope")).rejects.toThrow();
    expect(menu.handleMenuCallback).not.toHaveBeenCalled();
  });
});

// The callback body is only { restaurant, ingestion_succeeded } — no
// timestamp — so the dedupe key was "menu-callback:440823" for EVERY publish
// to that restaurant, forever. Live, 22 Sep 07:21:56: a genuine success was
// logged `first=false` and skipped. The per-publish token makes each
// publish's callback distinct while a true retry still collapses.
describe("menu-callback dedupe", () => {
  function makeController() {
    const seen = new Set<string>();
    const prisma = {
      webhookEvent: {
        create: jest.fn(async ({ data }: any) => {
          if (seen.has(data.externalEventId)) {
            const e: any = new Error("dup");
            e.code = "P2002";
            throw e;
          }
          seen.add(data.externalEventId);
          return data;
        }),
        update: jest.fn(async () => ({})),
      },
    } as any;
    const client = { verifyInboundApiKey: jest.fn(() => false) } as any;
    const menu = {
      handleMenuCallback: jest.fn().mockResolvedValue({ handled: true }),
      verifyCallbackToken: jest.fn().mockResolvedValue(true),
    } as any;
    return { controller: new JetLifecycleController(prisma, client, {} as any, menu, {} as any), menu };
  }
  const body = { restaurant: "440823", ingestion_succeeded: true };

  it("processes the callback of every separate publish", async () => {
    const { controller, menu } = makeController();
    await controller.menuCallback(body, undefined as any, undefined, "a".repeat(48));
    await controller.menuCallback(body, undefined as any, undefined, "b".repeat(48));
    expect(menu.handleMenuCallback).toHaveBeenCalledTimes(2);
  });

  it("still skips a true retry of the same publish's callback", async () => {
    const { controller, menu } = makeController();
    await controller.menuCallback(body, undefined as any, undefined, "a".repeat(48));
    await controller.menuCallback(body, undefined as any, undefined, "a".repeat(48));
    expect(menu.handleMenuCallback).toHaveBeenCalledTimes(1);
  });
});
