// Lightweight health-check endpoint for Render's zero-downtime deploys.
// Returns 200 instantly, host-agnostic, with NO marketing/host logic and
// NO upstream fetch — so a deploy's health check never stalls on the
// marketing home page (which is dynamic + host-aware). Point Render's
// "Health Check Path" at /healthz.
export const dynamic = "force-dynamic";

export function GET() {
  return new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });
}
