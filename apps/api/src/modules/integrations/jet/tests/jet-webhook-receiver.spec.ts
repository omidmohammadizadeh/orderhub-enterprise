import * as crypto from "crypto";
import { JetWebhookController } from "../jet-webhook.controller";
import { DELIVERY_BY_PARTNER } from "./jet-order.fixtures";

// The receiver's contract, in three parts:
//
//  1. IDEMPOTENCY. A redelivered webhook must never create a second order.
//     JET retries reuse the order id, so the WebhookEvent unique constraint on
//     [platform, externalEventId] is the guard and a P2002 is the "already
//     seen" signal — not an error.
//  2. RAW CAPTURE. The full envelope is persisted and logged BEFORE anything
//     interprets it. The transformer was written from the spec, and the spec
//     has been wrong for every other integration we have built; this is what
//     makes verifying against the first live order a five-minute job.
//  3. 202, FAST. Answering 202 hands us JET's 3-minute async window instead of
//     coupling their timeout to our database latency. Ingest runs after the
//     response, so the handler must not await it.

const SECRET = "whsec_jet_test";

function signed(body: string): string {
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64");
  return `HMAC-SHA256 t=1673428038618,signature=${sig}`;
}

function makeController(
  opts: { duplicate?: boolean; secretConfigured?: boolean; keyOk?: boolean } = {},
) {
  const created: any[] = [];
  const prisma = {
    webhookEvent: {
      create: jest.fn(async ({ data }: any) => {
        if (opts.duplicate) {
          const err: any = new Error("Unique constraint failed");
          err.code = "P2002";
          throw err;
        }
        created.push(data);
        return data;
      }),
      update: jest.fn(async () => ({})),
    },
  } as any;

  const client = {
    verifyInboundApiKey: jest.fn(() => opts.keyOk ?? true),
    verifyWebhookSignature: jest.fn((raw: Buffer | string, header?: string) => {
      const body = typeof raw === "string" ? raw : raw.toString("utf8");
      return header === signed(body);
    }),
    diagnoseSignatureVariant: jest.fn(() => "no_match"),
    webhookSecretConfigured: opts.secretConfigured ?? true,
    inboundApiKeyConfigured: true,
  } as any;

  const ingestOrder = jest.fn().mockResolvedValue({ handled: true });
  const orders = { ingestOrder } as any;
  const ack = { markPending: jest.fn().mockResolvedValue(undefined) } as any;

  return {
    controller: new JetWebhookController(prisma, client, orders, ack),
    prisma,
    created,
    ingestOrder,
    ack,
    client,
  };
}

function request(payload: unknown) {
  const raw = Buffer.from(JSON.stringify(payload));
  return { rawBody: raw, body: payload } as any;
}

/** Let the un-awaited ingest promise settle before asserting on it. */
const flush = () => new Promise((r) => setImmediate(r));

describe("JetWebhookController — receive order", () => {
  const payload = DELIVERY_BY_PARTNER;
  const raw = JSON.stringify(payload);

  it("answers with JET's order id so they can match the acknowledgement", async () => {
    const { controller } = makeController();
    const res = await controller.receiveOrder(
      request(payload),
      signed(raw),
      "key",
    );
    expect(res).toEqual({ OrderId: payload.id });
  });

  it("persists the raw envelope before interpreting anything", async () => {
    const { controller, created } = makeController();
    await controller.receiveOrder(request(payload), signed(raw), "key");

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      platform: "JUST_EAT",
      externalEventId: payload.id,
    });
    // The WHOLE payload, not a summary — this is the shape-verification record.
    expect(created[0]!.rawPayload).toEqual(payload);
  });

  it("registers the pending acknowledgement before returning", async () => {
    // If the process dies right after the 202, the watchdog needs something to
    // find. Recording it after the response would leave a window with nothing.
    const { controller, ack } = makeController();
    await controller.receiveOrder(request(payload), signed(raw), "key");
    expect(ack.markPending).toHaveBeenCalledWith({ jetOrderId: payload.id });
  });

  it("routes the order for ingest", async () => {
    const { controller, ingestOrder } = makeController();
    await controller.receiveOrder(request(payload), signed(raw), "key");
    await flush();
    expect(ingestOrder).toHaveBeenCalledWith(payload, { kind: "initial" });
  });

  it("does not wait for the ingest before responding", async () => {
    // 202 exists precisely so JET's timeout is not coupled to our DB latency.
    let release: (v: unknown) => void = () => {};
    const slow = jest.fn(() => new Promise((r) => (release = r)));
    const { controller } = makeController();
    (controller as any).orders.ingestOrder = slow;

    const res = await controller.receiveOrder(request(payload), signed(raw), "key");
    expect(res).toEqual({ OrderId: payload.id });
    expect(slow).toHaveBeenCalled();
    release(undefined);
  });
});

describe("JetWebhookController — idempotency", () => {
  const payload = DELIVERY_BY_PARTNER;
  const raw = JSON.stringify(payload);

  it("does not reprocess a redelivered order", async () => {
    // JET retries reuse the order id. Reprocessing would try to ack an order
    // they no longer hold pending, which 400s — and, without the DB unique
    // constraint underneath, would risk a second order on the board.
    const { controller, ingestOrder } = makeController({ duplicate: true });
    const res = await controller.receiveOrder(request(payload), signed(raw), "key");
    await flush();

    expect(res).toEqual({ OrderId: payload.id });
    expect(ingestOrder).not.toHaveBeenCalled();
  });

  it("still answers 202-shaped so JET stops retrying", async () => {
    const { controller, ack } = makeController({ duplicate: true });
    const res = await controller.receiveOrder(request(payload), signed(raw), "key");
    expect(res.OrderId).toBe(payload.id);
    expect(ack.markPending).not.toHaveBeenCalled();
  });
});

describe("JetWebhookController — authentication", () => {
  const payload = DELIVERY_BY_PARTNER;
  const raw = JSON.stringify(payload);

  it("rejects a bad signature without ingesting", async () => {
    const { controller, ingestOrder, client } = makeController();
    await controller.receiveOrder(request(payload), "HMAC-SHA256 t=1,signature=wrong", "key");
    await flush();

    expect(ingestOrder).not.toHaveBeenCalled();
    // A rejection must say WHICH failure it was: wrong secret or wrong format.
    expect(client.diagnoseSignatureVariant).toHaveBeenCalled();
  });

  it("rejects a bad inbound API key without ingesting", async () => {
    const { controller, ingestOrder } = makeController({ keyOk: false });
    await controller.receiveOrder(request(payload), signed(raw), "wrong-key");
    await flush();
    expect(ingestOrder).not.toHaveBeenCalled();
  });

  it("still records a rejected delivery for diagnosis", async () => {
    const { controller, created } = makeController();
    await controller.receiveOrder(request(payload), "t=1,signature=wrong", "key");
    // The envelope is captured regardless — a rejected webhook is exactly the
    // one you need to look at.
    expect(created).toHaveLength(1);
    expect(created[0]!.metadata.hmacOk).toBe(false);
  });

  it("processes orders when no secret is configured, and flags it", async () => {
    // Deliberate: rejecting everything on a fresh deploy would silently drop
    // live orders. The receiver logs the unauthenticated state loudly instead.
    const { controller, ingestOrder } = makeController({ secretConfigured: false });
    await controller.receiveOrder(request(payload), undefined, "key");
    await flush();
    expect(ingestOrder).toHaveBeenCalled();
  });
});

describe("JetWebhookController — malformed input", () => {
  it("survives a body that is not JSON", async () => {
    const { controller, ingestOrder } = makeController();
    const req = { rawBody: Buffer.from("not json at all"), body: {} } as any;
    const res = await controller.receiveOrder(req, "t=1,signature=x", "key");
    await flush();
    expect(res).toEqual({ OrderId: "" });
    expect(ingestOrder).not.toHaveBeenCalled();
  });

  it("does not ingest an order with no id", async () => {
    const body = { third_party_order_reference: "123" };
    const { controller, ingestOrder } = makeController();
    await controller.receiveOrder(
      request(body),
      signed(JSON.stringify(body)),
      "key",
    );
    await flush();
    expect(ingestOrder).not.toHaveBeenCalled();
  });
});

describe("JetWebhookController — final picked order", () => {
  it("routes to the amendment path, not the create path", async () => {
    const payload = DELIVERY_BY_PARTNER;
    const { controller, ingestOrder } = makeController();
    await controller.receiveFinalPickedOrder(
      request(payload),
      signed(JSON.stringify(payload)),
      "key",
    );
    await flush();
    expect(ingestOrder).toHaveBeenCalledWith(payload, { kind: "final" });
  });
});
