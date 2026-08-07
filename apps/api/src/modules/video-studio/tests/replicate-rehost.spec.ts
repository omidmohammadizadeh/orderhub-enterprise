// A finished video has to still play tomorrow.
//
// persist() falls back to the provider's own URL when re-hosting fails, and a
// replicate.delivery link is publicly playable for about an hour. Storing one
// as a finished creation produces a video that works the moment you make it
// and is a dead black box the next day — worse than a render that visibly
// failed, because the credit is spent and nothing looks wrong until later.
//
// The Veo path already refused to do this. Replicate did not, because its URL
// is *briefly* playable, which is exactly what made the failure invisible.

import { VideoStudioService } from "../video-studio.service";

const PROVIDER_URL = "https://replicate.delivery/pbxt/abc/out.mp4";
const STORED_URL = "https://supabase.co/storage/v1/object/public/x/video.mp4";

function makeService(opts: {
  persistReturns: string;
  createdAt: Date;
  reason?: string;
}) {
  const updates: any[] = [];
  const refunds: any[] = [];
  const gen = {
    id: "g1",
    kind: "VIDEO",
    replicatePredictionId: "pred_1",
    createdAt: opts.createdAt,
  };

  const svc = Object.create(VideoStudioService.prototype) as any;
  svc.logger = { log() {}, warn() {}, error() {} };
  svc.replicate = {
    isConfigured: () => true,
    getPrediction: async () => ({ status: "succeeded", output: PROVIDER_URL }),
    outputUrl: (o: any) => o,
  };
  svc.gemini = { isConfigured: () => false };
  svc.persist = async () => ({
    url: opts.persistReturns,
    rehosted: opts.persistReturns !== PROVIDER_URL,
    reason: opts.reason,
  });
  svc.failAndRefund = async (g: any, reason: string) =>
    refunds.push({ id: g.id, reason });
  svc.db = () => ({
    videoGeneration: {
      findMany: async () => [gen],
      update: async (args: any) => {
        updates.push(args);
        return args;
      },
    },
  });
  return { svc, updates, refunds };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe("a Replicate render is only READY once we own the file", () => {
  it("marks it READY when re-hosting worked", async () => {
    const { svc, updates, refunds } = makeService({
      persistReturns: STORED_URL,
      createdAt: minutesAgo(1),
    });
    await svc.reconcile();
    expect(updates[0].data).toMatchObject({
      status: "READY",
      resultUrl: STORED_URL,
    });
    expect(refunds).toHaveLength(0);
  });

  it("does NOT store the provider URL when re-hosting failed", async () => {
    // The bug: this used to be marked READY with a link that expires.
    const { svc, updates, refunds } = makeService({
      persistReturns: PROVIDER_URL,
      createdAt: minutesAgo(1),
    });
    await svc.reconcile();
    expect(updates).toHaveLength(0);
    expect(refunds).toHaveLength(0); // still retrying, not given up
  });

  it("refunds rather than storing an expiring URL once it is clearly stuck", async () => {
    const { svc, updates, refunds } = makeService({
      persistReturns: PROVIDER_URL,
      createdAt: minutesAgo(45),
    });
    await svc.reconcile();
    expect(updates).toHaveLength(0);
    expect(refunds[0].reason).toMatch(/couldn't save/i);
  });

  it("keeps retrying inside the window rather than burning the credit early", async () => {
    // The output exists and has been paid for; a download blip must not be
    // terminal.
    const { svc, refunds } = makeService({
      persistReturns: PROVIDER_URL,
      createdAt: minutesAgo(19),
    });
    await svc.reconcile();
    expect(refunds).toHaveLength(0);
  });
});


describe("storage switched off is the operator's problem, not the render's", () => {
  it("keeps the provider URL rather than refunding every single video", async () => {
    // Retrying cannot fix an unset env var. Refusing here would mean nobody
    // ever gets a video at all — strictly worse than one that plays for an
    // hour while somebody notices the banner and fixes the config.
    const { svc, updates, refunds } = makeService({
      persistReturns: PROVIDER_URL,
      reason: "not-configured",
      createdAt: minutesAgo(45),
    });
    await svc.reconcile();
    expect(refunds).toHaveLength(0);
    expect(updates[0].data).toMatchObject({
      status: "READY",
      resultUrl: PROVIDER_URL,
    });
  });
});
