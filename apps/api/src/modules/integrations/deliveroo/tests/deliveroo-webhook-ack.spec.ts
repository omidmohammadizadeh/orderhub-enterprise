// Deliveroo waited for the whole ingest before hearing anything back.
//
// Their dashboard, one month of production: 6,220 order-event callbacks, of
// which 330 (5.3%) came back `-1` — no HTTP response at all — plus 4 failed
// syncs for `no_sync_confirmation`. We were making them wait for menu
// resolution, the order write, customer backfill and print jobs before the
// 200. Node does not abort a handler when the client disconnects, so those
// orders did land and the retries were deduped; what it cost was a permanent
// 5% failure band, no headroom before retries start missing too, and real
// faults hidden inside the noise.
//
// The 200 now goes back first. Nothing is weakened by that: routing errors
// were ALREADY swallowed into a 200, so Deliveroo never retried on a handler
// failure — it was only ever waiting for an outcome it was not told.

import { DeliverooWebhookController } from '../deliveroo-webhook.controller';

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A controller whose HMAC always verifies and whose router we drive. */
const build = (route: (event: string, body: any) => Promise<any>) => {
  const routed: string[] = [];
  const c: any = Object.create(DeliverooWebhookController.prototype);
  (c as any).lanes = new Map();
  c.logger = { log() {}, warn() {}, error() {} };
  c.client = {
    verifyWebhookSignature: () => true,
    signatureDiagnostics: () => ({ configured: true }),
    diagnoseSignatureVariant: () => 'none',
  };
  c.prisma = {
    webhookEvent: {
      create: async () => ({}),
      update: () => ({ catch: () => Promise.resolve() }),
    },
  };
  c.orderRouter = { route };
  return { c, routed };
};

const req = (body: any) => ({ rawBody: Buffer.from(JSON.stringify(body)), body }) as any;

describe('acknowledging Deliveroo before doing the work', () => {
  it('returns 200 without waiting for the ingest', async () => {
    let released: () => void = () => {};
    const slow = new Promise<void>((r) => (released = r));
    const { c } = build(async () => {
      await slow; // an ingest that never finishes on its own
      return { handled: true };
    });

    const startedAt = Date.now();
    const res = await c.receive(req({ event: 'order.new', order: { id: 'o1' } }), 'seq-1', 'sig');
    const tookMs = Date.now() - startedAt;

    expect(res).toEqual({ ok: true });
    expect(tookMs).toBeLessThan(50); // the old code returned only after the ingest
    released();
    await settle();
  });

  it('still runs the routing, after the reply', async () => {
    const seen: string[] = [];
    const { c } = build(async (event) => {
      await settle(5);
      seen.push(event);
      return { handled: true };
    });

    await c.receive(req({ event: 'order.new', order: { id: 'o1' } }), 'seq-1', 'sig');
    expect(seen).toEqual([]); // nothing done yet — that is the point
    await settle(40);
    expect(seen).toEqual(['order.new']); // and it happened anyway
  });

  it('keeps events for one order in the order they arrived', async () => {
    // A status_update that overtakes its own order.new finds no order to
    // update. The old code spaced these apart by accident, with the very
    // latency being removed.
    const finished: string[] = [];
    const { c } = build(async (event) => {
      // order.new is the slow one — exactly the race that matters.
      await settle(event === 'order.new' ? 30 : 1);
      finished.push(event);
      return { handled: true };
    });

    await c.receive(req({ event: 'order.new', order: { id: 'o1' } }), 'seq-1', 'sig');
    await c.receive(req({ event: 'order.status_update', order: { id: 'o1' } }), 'seq-2', 'sig');
    await settle(120);

    expect(finished).toEqual(['order.new', 'order.status_update']);
  });

  it('lets different orders run at the same time', async () => {
    const finished: string[] = [];
    const { c } = build(async (_e, body) => {
      const id = body?.order?.id;
      await settle(id === 'slow' ? 40 : 1);
      finished.push(id);
      return { handled: true };
    });

    await c.receive(req({ event: 'order.new', order: { id: 'slow' } }), 'seq-1', 'sig');
    await c.receive(req({ event: 'order.new', order: { id: 'fast' } }), 'seq-2', 'sig');
    await settle(120);

    // The quick one did not queue behind the slow one.
    expect(finished).toEqual(['fast', 'slow']);
  });

  it('a handler that throws never becomes an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);

    const { c } = build(async () => {
      throw new Error('ingest exploded');
    });
    const res = await c.receive(req({ event: 'order.new', order: { id: 'o1' } }), 'seq-1', 'sig');
    await settle(50);
    process.off('unhandledRejection', onUnhandled);

    expect(res).toEqual({ ok: true }); // Deliveroo is told nothing is wrong, as before
    expect(unhandled).toEqual([]);
  });

  it('a throw does not block the next event for the same order', async () => {
    const finished: string[] = [];
    const { c } = build(async (event) => {
      if (event === 'order.new') throw new Error('boom');
      finished.push(event);
      return { handled: true };
    });

    await c.receive(req({ event: 'order.new', order: { id: 'o1' } }), 'seq-1', 'sig');
    await c.receive(req({ event: 'order.status_update', order: { id: 'o1' } }), 'seq-2', 'sig');
    await settle(60);

    expect(finished).toEqual(['order.status_update']);
  });

  it('does not leak a lane per order', async () => {
    const { c } = build(async () => ({ handled: true }));
    for (let i = 0; i < 25; i++) {
      await c.receive(req({ event: 'order.new', order: { id: `o${i}` } }), `seq-${i}`, 'sig');
    }
    await settle(60);
    expect(c.lanes.size).toBe(0);
  });
});
