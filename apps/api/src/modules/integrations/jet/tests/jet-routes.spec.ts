import * as fs from "fs";
import * as path from "path";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { JetController } from "../jet.controller";
import { JetWebhookController } from "../jet-webhook.controller";
import { JetLifecycleController } from "../jet-lifecycle.controller";

// The URLs JET will call are a CONTRACT, not an implementation detail.
//
// Before the build, our email to JET (David) put these in writing, and JET
// copied them into the integration workbook's Capability tab:
//
//   Base URL              https://orderhub-api-0re6.onrender.com/api/v1/integrations/justeat
//   Orders                /orders
//   Cancelled orders      /orders/cancel
//   Driver notifications  /driver-status
//
// The build then mounted everything under `integrations/jet`, with cancel at
// `/cancel`, and nothing checked the two against each other — so every URL
// JET had on file would have 404'd. A 404 on the order webhook is a silent
// "failed to inject" against the 99.5% SLA, and it skips the shop's backup
// flow. A later email then asked JET to switch to the `/jet` spellings, so
// either set may end up configured: BOTH must resolve.
//
// This resolves routes the way Nest does — module controller order, then
// declaration order within a controller — so a shadowing route fails here too.

type Route = {
  method: RequestMethod;
  pattern: RegExp;
  path: string;
  handler: string;
  controller: string;
};

const asArray = (v: string | string[] | undefined): string[] =>
  v === undefined ? [""] : Array.isArray(v) ? v : [v];

const joinPath = (...parts: string[]) =>
  "/" + parts.flatMap((p) => p.split("/")).filter(Boolean).join("/");

function routesOf(ctrl: any): Route[] {
  const prefixes = asArray(Reflect.getMetadata(PATH_METADATA, ctrl));
  const out: Route[] = [];
  for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
    const fn = ctrl.prototype[name];
    if (name === "constructor" || typeof fn !== "function") continue;
    const method = Reflect.getMetadata(METHOD_METADATA, fn);
    if (method === undefined) continue;
    for (const prefix of prefixes) {
      for (const sub of asArray(Reflect.getMetadata(PATH_METADATA, fn))) {
        const path = joinPath("api", "v1", prefix, sub);
        out.push({
          method,
          path,
          pattern: new RegExp("^" + path.replace(/:[^/]+/g, "[^/]+") + "$"),
          handler: name,
          controller: ctrl.name,
        });
      }
    }
  }
  return out;
}

// Registration order is what decides shadowing, so it is read from the
// module itself. (Importing JetModule would drag in the whole auth graph.)
const BY_NAME: Record<string, any> = {
  JetController,
  JetWebhookController,
  JetLifecycleController,
};
const moduleSource = fs.readFileSync(
  path.join(__dirname, "..", "jet.module.ts"),
  "utf8",
);
const controllerNames = (moduleSource.match(/controllers:\s*\[([^\]]*)\]/)?.[1] ?? "")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean);
const ROUTES = controllerNames.map((n) => BY_NAME[n]).flatMap(routesOf);

function resolve(method: RequestMethod, url: string) {
  const hit = ROUTES.find((r) => r.method === method && r.pattern.test(url));
  return hit ? `${hit.controller}.${hit.handler}` : null;
}

const POST = RequestMethod.POST;

describe("JET inbound URLs", () => {
  it("reads every controller the module registers", () => {
    expect(controllerNames.length).toBeGreaterThan(0);
    for (const n of controllerNames) expect([n, !!BY_NAME[n]]).toEqual([n, true]);
  });

  it("serves every URL in our written commitment to JET", () => {
    const base = "/api/v1/integrations/justeat";
    expect(resolve(POST, `${base}/orders`)).toBe("JetWebhookController.receiveOrder");
    expect(resolve(POST, `${base}/orders/cancel`)).toBe("JetLifecycleController.cancel");
    expect(resolve(POST, `${base}/driver-status`)).toBe(
      "JetLifecycleController.driverStatus",
    );
  });

  it("still serves the /jet spellings, since JET may have configured those", () => {
    const base = "/api/v1/integrations/jet";
    expect(resolve(POST, `${base}/orders`)).toBe("JetWebhookController.receiveOrder");
    expect(resolve(POST, `${base}/cancel`)).toBe("JetLifecycleController.cancel");
    expect(resolve(POST, `${base}/driver-status`)).toBe(
      "JetLifecycleController.driverStatus",
    );
  });

  it("serves every inbound webhook under both prefixes", () => {
    const expected: Record<string, string> = {
      orders: "JetWebhookController.receiveOrder",
      final: "JetWebhookController.receiveFinalPickedOrder",
      cancel: "JetLifecycleController.cancel",
      "orders/cancel": "JetLifecycleController.cancel",
      "driver-status": "JetLifecycleController.driverStatus",
      "store-status": "JetLifecycleController.storeStatus",
      "failed-order": "JetLifecycleController.failedOrder",
      "menu-callback": "JetLifecycleController.menuCallback",
      "modification-callback": "JetLifecycleController.modificationCallback",
    };
    for (const prefix of ["jet", "justeat"]) {
      for (const [sub, handler] of Object.entries(expected)) {
        expect([sub, prefix, resolve(POST, `/api/v1/integrations/${prefix}/${sub}`)]).toEqual([
          sub,
          prefix,
          handler,
        ]);
      }
    }
  });

  it("aliases ONLY the inbound webhooks — dashboard routes stay on /jet alone", () => {
    // The alias exists for JET's benefit. Connect, disconnect, pause and the
    // modification actions are merchant-authenticated dashboard routes and
    // gain nothing from a second public spelling.
    const base = "/api/v1/integrations/justeat";
    expect(resolve(POST, `${base}/connect`)).toBeNull();
    expect(resolve(POST, `${base}/conn-1/disconnect`)).toBeNull();
    expect(resolve(POST, `${base}/orders/o-1/modification`)).toBeNull();
    expect(resolve(RequestMethod.GET, `${base}/connections`)).toBeNull();
  });
});
