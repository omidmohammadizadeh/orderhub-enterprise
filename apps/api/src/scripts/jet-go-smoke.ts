/**
 * JET Go staging smoke test.
 *
 * Drives the REAL JetGoClientService — the same code a dispatch uses — so a
 * green run here says the shipped integration works, not that a second
 * implementation written for the test does.
 *
 * Credentials come from the environment, never from a file in the repo:
 *
 *   JET_GO_CLIENT_ID=... JET_GO_CLIENT_SECRET=... pnpm jet-go:smoke
 *
 * By default it only authenticates, lists the collect points and prices one
 * delivery — nothing is booked. Add --create to book it, and --simulate to walk
 * the booked delivery through its whole lifecycle (which fires the webhooks at
 * whatever notification-config is registered, so register one first or you will
 * see nothing arrive).
 *
 * Defaults are the staging store JET gave us: Orderhub test store, 38 Exchange
 * St E, Liverpool L2 3PS, max 10km delivery radius. Override any of them with
 * JET_GO_COLLECT_POINT_ID / JET_GO_DROPOFF_* if that store is ever replaced.
 */

import {
  JetGoClientService,
  type JetGoCreds,
  type JetGoEstimateBody,
} from "../modules/integrations/jet-go/jet-go-client.service";

const CREDS: JetGoCreds = {
  clientId: process.env.JET_GO_CLIENT_ID ?? "",
  clientSecret: process.env.JET_GO_CLIENT_SECRET ?? "",
  market: process.env.JET_GO_MARKET ?? "UK",
  environment: process.env.JET_GO_ENV ?? "sandbox",
};

const COLLECT_POINT_ID =
  process.env.JET_GO_COLLECT_POINT_ID ?? "106c294f-ccdd-455f-b4ed-bb1c450ccb14";

// Mann Island, ~700m from the test store — comfortably inside the 10km radius.
const DROPOFF = {
  name: process.env.JET_GO_DROPOFF_NAME ?? "OrderHub Test Customer",
  emailAddress: process.env.JET_GO_DROPOFF_EMAIL ?? "noreply@orderhubsolutions.com",
  phoneNumber: process.env.JET_GO_DROPOFF_PHONE ?? "+447700900123",
  address: process.env.JET_GO_DROPOFF_ADDRESS ?? "1 Mann Island",
  city: process.env.JET_GO_DROPOFF_CITY ?? "Liverpool",
  postalCode: process.env.JET_GO_DROPOFF_POSTCODE ?? "L3 1BP",
  lat: Number(process.env.JET_GO_DROPOFF_LAT ?? 53.40452),
  lng: Number(process.env.JET_GO_DROPOFF_LNG ?? -2.99603),
};

const argv = process.argv.slice(2);
const DO_CREATE = argv.includes("--create") || argv.includes("--simulate");
const DO_SIMULATE = argv.includes("--simulate");

const ok = (m: string) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const info = (m: string) => console.log(`  ${m}`);
const fail = (m: string) => console.log(`\x1b[31m✗\x1b[0m ${m}`);
const step = (m: string) => console.log(`\n\x1b[1m${m}\x1b[0m`);

async function main() {
  if (!CREDS.clientId || !CREDS.clientSecret) {
    fail("Set JET_GO_CLIENT_ID and JET_GO_CLIENT_SECRET first.");
    process.exit(1);
  }

  const client = new JetGoClientService();
  console.log(`\x1b[1mJET Go smoke test\x1b[0m — ${CREDS.market} / ${CREDS.environment}`);
  info(`auth: ${client.authBase(CREDS)}`);
  info(`api:  ${client.apiBase(CREDS)}`);

  // 1 ── auth + collect points. One call proves the token host, the API host,
  //      the Basic-auth shape and the User-Agent header all at once.
  step("1. Authenticate and list collect points");
  const points = await client.collectPoints(CREDS);
  ok(`authenticated, ${points.length} collect point(s)`);
  for (const p of points) {
    const mine = p.id === COLLECT_POINT_ID ? "  ← using this one" : "";
    info(`${p.id}  ${p.name ?? "(unnamed)"}  ${[p.address, p.city, p.postalCode].filter(Boolean).join(", ")}${mine}`);
  }
  if (!points.some((p) => p.id === COLLECT_POINT_ID)) {
    fail(
      `Collect point ${COLLECT_POINT_ID} is not on these credentials — ` +
        `set JET_GO_COLLECT_POINT_ID to one of the ids above.`,
    );
    process.exit(1);
  }

  // 2 ── estimate. The requestId it returns is what everything else keys off,
  //      and it expires in five minutes.
  step("2. Price a delivery");
  const body: JetGoEstimateBody = {
    collect: { id: COLLECT_POINT_ID },
    delivery: {
      name: DROPOFF.name,
      emailAddress: DROPOFF.emailAddress,
      phoneNumber: DROPOFF.phoneNumber,
      address: DROPOFF.address,
      city: DROPOFF.city,
      postalCode: DROPOFF.postalCode,
      // [latitude, longitude] — JET's order, not GeoJSON's.
      geolocation: { coordinates: [DROPOFF.lat, DROPOFF.lng], type: "point" },
    },
    deliveryDetails: { weightGrams: 1500, preparationDuration: 15, hasAlcohol: false },
    deliveryOptions: { unreachablePreference: "RETURN", dropoffAction: "MEET_AT_DOOR" },
  };
  const estimate = await client.estimate(CREDS, body);
  ok(`requestId ${estimate.requestId}`);
  info(`courier fee: ${estimate.dynamicDeliveryFee} (minor units) — rule "${estimate.dynamicDeliveryFeeRule ?? "?"}"`);
  info(`collect by:  ${estimate.estimatedEarliestCollectTime ?? estimate.targetCollectTime ?? "—"}`);
  info(`deliver by:  ${estimate.estimatedEarliestDeliverTime ?? estimate.targetDeliverTime ?? "—"}`);

  if (!DO_CREATE) {
    step("Done — nothing was booked.");
    info("Re-run with --create to book it, or --simulate to book and drive the lifecycle.");
    return;
  }

  // 3 ── book it. 202 means ACCEPTED, not created; DELIVERYCREATED is the proof.
  step("3. Book the delivery");
  await client.createDelivery(CREDS, {
    requestId: estimate.requestId,
    specialInstructions: "OrderHub smoke test — no food, do not collect",
    orderValue: 2000,
    vendorOrderId: `SMOKE-${Date.now().toString().slice(-6)}`,
    paymentType: "PREPAID",
    metadata: { source: "orderhub-smoke-test" },
  });
  ok("accepted (202) — JET confirms it with a DELIVERYCREATED webhook");

  if (!DO_SIMULATE) {
    step("Done.");
    info(`Check it with: GET /v1/delivery/status/${estimate.requestId}`);
    return;
  }

  // 4 ── drive the lifecycle. Staging only.
  step("4. Simulate the full lifecycle");
  const sim = await client.simulate(CREDS, {
    requestId: estimate.requestId,
    stepWaitDuration: 3000,
  });
  ok(sim?.message ?? "simulation started");
  info("Webhooks fire at the registered notification endpoint, ~3s apart,");
  info("through ASSIGNED → IN_TRANSIT_TO_COLLECT → … → DELIVERED.");

  step("5. Final status");
  await new Promise((r) => setTimeout(r, 5000));
  const status = await client.deliveryStatus(CREDS, estimate.requestId);
  ok(`status: ${status?.status ?? "?"} (vendorOrderId ${status?.vendorOrderId ?? "?"})`);
}

main().catch((err: any) => {
  fail(err?.message ?? String(err));
  if (err?.body) console.error("  body:", JSON.stringify(err.body, null, 2));
  process.exit(1);
});
