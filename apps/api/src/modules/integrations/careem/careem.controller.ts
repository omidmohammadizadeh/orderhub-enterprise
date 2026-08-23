import { Controller, Get, Logger, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles } from "../../../common/decorators/roles.decorator";
import { CareemAuthError, CareemClientService } from "./careem-client.service";
import { CareemWebhookLogService } from "./careem-webhook-log.service";

// Phase CA-0 — "are the credentials actually working?"
//
// Setting four environment variables and redeploying tells you nothing about
// whether Careem accepts them. This does: it asks for a token, then asks for
// the brands and branches those credentials can see, and reports what came
// back. It's the same job as a doctor command, reachable from a browser
// because that's easier than shell access on Render.
//
// It also answers the question the webhook endpoint deliberately refuses to:
// whether a correctly-keyed notification has ever arrived. The receiver
// returns 200 on a bad key so a prober learns nothing, which leaves the
// operator who just configured that key with no feedback either.
//
// Admin only, and it never returns the credentials themselves — only whether
// each is present and what Careem did with them.
@ApiTags("integrations")
@ApiBearerAuth()
@Controller({ path: "integrations/careem", version: "1" })
export class CareemController {
  private readonly logger = new Logger(CareemController.name);

  constructor(
    private readonly client: CareemClientService,
    private readonly seen: CareemWebhookLogService,
  ) {}

  @Get("diagnostics")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER")
  @ApiOperation({
    summary: "Check Careem credentials, list visible brands/branches, and show recent webhooks",
  })
  async diagnostics() {
    const out: Record<string, unknown> = {
      environment: this.client.env,
      baseUrl: this.client.baseUrl,
      // Presence, never the value.
      clientIdSet: !!process.env.CAREEM_CLIENT_ID,
      clientSecretSet: !!process.env.CAREEM_CLIENT_SECRET,
      webhookKeySet: !!process.env.CAREEM_WEBHOOK_API_KEY,
      webhookUrl: `${(process.env.API_URL ?? "").replace(/\/+$/, "")}/api/v1/webhooks/careem`,
      tokenUrl: this.client.tokenUrl,
    };

    if (!this.client.configured()) {
      out.token = "not configured — set CAREEM_CLIENT_ID and CAREEM_CLIENT_SECRET";
      out.webhooks = this.webhookSummary();
      return out;
    }

    // 1. Can we authenticate at all?
    try {
      const token = await this.client.accessToken(true);
      out.token = { ok: true, length: token.length };
    } catch (err) {
      out.token =
        err instanceof CareemAuthError
          ? {
              ok: false,
              status: err.status,
              tokenUrl: err.tokenUrl,
              // Verbatim. Careem's errors name the actual problem — e.g.
              // "clients not found for client_id=…", which their FAQ says
              // means the webhook isn't configured for this environment.
              careemSaid: err.body.slice(0, 1000),
              hint: hintFor(err),
            }
          : { ok: false, error: (err as Error).message };
      out.webhooks = this.webhookSummary();
      return out; // nothing below can work without one
    }

    // 2. What can those credentials actually see? Doubles as the list of ids
    //    every later phase needs — a catalog is uploaded per BRANCH, and an
    //    order names the branch it came from.
    out.brands = await this.safe(() => this.client.request("/brands"));
    out.branches = await this.safe(() => this.client.request("/branches"));
    out.webhooks = this.webhookSummary();
    return out;
  }

  @Get("webhooks")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER")
  @ApiOperation({
    summary: "The last few Careem notifications received, with their full payloads",
  })
  recentWebhooks(@Query("limit") limit?: string) {
    const n = Math.min(25, Math.max(1, Number(limit) || 10));
    return {
      note:
        "In-memory and per-instance — lost on restart. For reading real payload " +
        "shapes while building, not an audit trail.",
      ...this.webhookSummary(),
      events: this.seen.recent(n),
    };
  }

  private webhookSummary() {
    const recent = this.seen.recent();
    return {
      receivedSinceRestart: recent.length,
      everAuthenticated: this.seen.everAuthenticated,
      lastAt: recent[0]?.at ?? null,
      hint: recent.length
        ? this.seen.everAuthenticated
          ? "A correctly-keyed webhook has arrived — the key matches."
          : "Webhooks are arriving but NONE authenticated: CAREEM_WEBHOOK_API_KEY does not match the value saved in Careem's portal."
        : "Nothing received yet. Check the URL saved in Careem's portal ends with /api/v1/webhooks/careem.",
    };
  }

  private hintFor = hintFor;

  /** Never let one failing call hide the rest of the diagnosis. */
  private async safe<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
}

/**
 * Turn Careem's error into the next thing to actually do.
 *
 * Their messages are specific and their FAQ maps several of them to a fix, so
 * this is a lookup rather than a guess. Anything unrecognised says so instead
 * of inventing an explanation.
 */
function hintFor(err: CareemAuthError): string {
  const body = err.body.toLowerCase();
  if (body.includes("clients not found")) {
    return (
      "Careem doesn't recognise this client_id on this environment. Their FAQ " +
      "maps this exact error to a webhook URL not being configured for the " +
      "environment — confirm the sandbox credential in the portal has the " +
      "webhook URL and x-careem-api-key saved against it, and that these are " +
      "the SANDBOX credentials rather than production ones."
    );
  }
  if (err.status === 401 || body.includes("invalid_client")) {
    return (
      "The client id or secret was rejected. Re-check both for whitespace or a " +
      "truncated paste — Careem shows them once and they are long."
    );
  }
  if (err.status === 404) {
    return (
      "The token endpoint 404'd, which points at the URL rather than the " +
      "credentials. We default to Careem's identity provider " +
      "(https://identity.careem.com/token) because the gateway path in their " +
      "spec returns a bare Symfony NotFoundHttpException. If CAREEM_TOKEN_URL " +
      "is set, clear it."
    );
  }
  if (err.status === 429) {
    return "Rate limited. Their docs warn that requesting a token per API call can get an IP blocked — we cache, so this is more likely a shared IP.";
  }
  return "Unrecognised error — send the `careemSaid` text to Careem support.";
}
