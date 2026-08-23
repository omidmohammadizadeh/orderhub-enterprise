import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles } from "../../../common/decorators/roles.decorator";
import {
  CareemApiError,
  CareemAuthError,
  CareemClientService,
} from "./careem-client.service";
import { CareemWebhookLogService } from "./careem-webhook-log.service";
import { CareemStoreService } from "./careem-store.service";
import { CareemMenuPublishService } from "./careem-menu-publish.service";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";

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
    private readonly store: CareemStoreService,
    private readonly menu: CareemMenuPublishService,
  ) {}

  @Get("diagnostics")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER")
  @ApiOperation({
    summary: "Check Careem credentials, list visible brands/branches, and show recent webhooks",
  })
  async diagnostics() {
    // Whether ANY of what follows is Careem. With the sandbox on, the token
    // and the gateway are both this server, so "credentials accepted" means we
    // accepted our own — which is the one thing this page must never imply.
    const sandbox =
      process.env.CAREEM_SANDBOX === "true" &&
      process.env.CAREEM_ENV !== "production";

    const out: Record<string, unknown> = {
      sandbox,
      ...(sandbox
        ? {
            sandboxWarning:
              "The sandbox is ON. The token and gateway below are this server " +
              "answering as Careem. Nothing here says anything about whether " +
              "Careem accept our credentials — unset CAREEM_SANDBOX to find out.",
          }
        : {}),
      environment: this.client.env,
      baseUrl: this.client.baseUrl,
      // Presence, never the value.
      clientIdSet: !!process.env.CAREEM_CLIENT_ID,
      clientSecretSet: !!process.env.CAREEM_CLIENT_SECRET,
      webhookKeySet: !!process.env.CAREEM_WEBHOOK_API_KEY,
      webhookUrl: `${(process.env.API_URL ?? "").replace(/\/+$/, "")}/api/v1/webhooks/careem`,
      tokenUrl: this.client.tokenUrl,
      // Non-zero means we are deliberately not re-asking, so a stale error on
      // screen isn't mistaken for a live one.
      retryInSeconds: this.client.cooldownSeconds,
    };

    if (!this.client.configured()) {
      out.token = "not configured — set CAREEM_CLIENT_ID and CAREEM_CLIENT_SECRET";
      out.webhooks = this.webhookSummary();
      return out;
    }

    // 1. Can we authenticate at all?
    try {
      // NOT forced. This page polls, and a forced refresh here meant up to six
      // token requests every thirty seconds — which is what got us rate-limited
      // by Cloudflare in the first place. Their docs warn an IP block "might
      // require manual intervention" to undo.
      const token = await this.client.accessToken();
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

  @Post("retry")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER")
  @ApiOperation({
    summary: "Clear the failure cooldown and ask Careem again right now",
  })
  async retry() {
    this.client.resetCooldown();
    try {
      await this.client.accessToken(true);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof CareemAuthError ? err.body.slice(0, 400) : String(err),
      };
    }
  }

  @Get("auth-probe")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER")
  @ApiOperation({
    summary:
      "Try every OAuth client-authentication style against Careem and report each result",
  })
  async authProbe() {
    // Six requests in one go. Fine as a deliberate button press, never on a
    // timer — see the cooldown note in CareemClientService.
    const results = await this.client.diagnoseAuth();
    const winner = results.find((r) => r.ok);
    return {
      tokenUrl: this.client.tokenUrl,
      results,
      conclusion: results.some((r) => r.status === 429)
        ? "Careem is RATE LIMITING us (HTTP 429, via Cloudflare). Stop probing — " +
          "their docs warn that repeated token requests can escalate to an IP " +
          "block needing manual intervention. Wait, and ask your Careem contact " +
          "to confirm the block is lifted."
        : winner
          ? `Careem accepts "${winner.variant}" — the client now uses it automatically.`
          : results.every((r) => /invalid_client|bad credentials/i.test(r.body))
          ? "Every combination was rejected, so it is the CREDENTIALS rather than " +
            "the request. Careem's own integration process says they issue the " +
            "POS OAuth client: step 2 is 'Setup client — We would set up an " +
            "OAuth client on our end and share its credentials with you.' The " +
            "self-serve Sandbox credentials dialog in the Developer Hub does not " +
            "appear to issue a POS client. Ask your Careem contact to provision " +
            "one. Their prerequisites also list contract completion and approval " +
            "from their information security and legal teams before API access."
            : "No style succeeded and the errors differ — read them below.",
    };
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

  // ── Phase CA-4: setting a shop up, and opening or closing it ─────────────
  //
  // Everything below is scoped to the caller's tenant inside the service, so a
  // location id from a browser can only ever reach that tenant's own shops.

  @Post("locations/:locationId/onboard")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Register the brand + branch with Careem and publish its hours",
  })
  onboard(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.explain("onboard", () =>
      this.store.onboardLocation(user.tenantId, locationId),
    );
  }

  @Post("locations/:locationId/hours")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Push this shop's opening hours to Careem" })
  publishHours(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.explain("publish hours", () =>
      this.store.publishHours(user.tenantId, locationId),
    );
  }

  @Get("locations/:locationId/visibility")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Is this branch orderable on the Careem SuperApp?" })
  visibility(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.explain("read visibility", () =>
      this.store.visibility(user.tenantId, locationId),
    );
  }

  @Post("locations/:locationId/visibility")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Open or close this branch to Careem customers",
  })
  setVisibility(
    @Param("locationId") locationId: string,
    @Body() body: { open: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.explain("set visibility", () =>
      this.store.setVisibility(user.tenantId, locationId, !!body?.open),
    );
  }

  @Post("locations/:locationId/pause")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Stop Careem orders for N minutes — Careem reopen it themselves",
  })
  pause(
    @Param("locationId") locationId: string,
    @Body() body: { minutes: number },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.explain("pause", () =>
      this.store.pauseFor(user.tenantId, locationId, Number(body?.minutes)),
    );
  }

  // The switch that decides whether Careem's orders are ours to cook. Separate
  // from onboarding on purpose — see CareemStoreService.
  @Post("locations/:locationId/pos-integration")
  @Roles("TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Route Careem orders to us, or back to the branch's own tablet",
  })
  setPosIntegration(
    @Param("locationId") locationId: string,
    @Body() body: { active: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.store.setPosIntegration(
      user.tenantId,
      locationId,
      !!body?.active,
    );
  }

  @Post("locations/:locationId/menu/publish")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Publish this shop's menu as a Careem catalog (~5 min to go live)",
  })
  publishMenu(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.explain("publish menu", () =>
      this.menu.publish(locationId, user.tenantId),
    );
  }

  @Post("locations/:locationId/menu/reset")
  @Roles("TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Reset a branch's Careem catalog — only for data inconsistencies, and " +
      "it takes effect on the next full publish",
  })
  resetMenu(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menu.resetCatalog(locationId, user.tenantId);
  }

  @Get("locations/:locationId/menu/status/:requestId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Track a catalog upload Careem accepted earlier" })
  menuStatus(
    @Param("locationId") locationId: string,
    @Param("requestId") requestId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.explain("menu status", () =>
      this.menu.status(locationId, requestId, user.tenantId),
    );
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

  /**
   * Let a genuine crash through with its cause attached.
   *
   * Nest turns anything that isn't an HttpException into "Internal server
   * error" and nothing else. That is right for a public API and wrong for
   * these routes, which exist to be run by hand while wiring an integration
   * up — a bare 500 sends the reader to the Render logs, away from the screen
   * that was meant to answer the question.
   */
  private async explain<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // Careem's own rejection, with their status kept. A 400 from them is a
      // 400 from us — turning it into a 500 would say the fault was ours.
      if (err instanceof CareemApiError) {
        throw new HttpException(
          { step: what, status: err.status, careemSaid: err.message },
          err.status >= 400 && err.status < 600 ? err.status : 502,
        );
      }
      const message =
        err instanceof CareemAuthError
          ? `Careem auth failed (HTTP ${err.status} from ${err.tokenUrl}): ${err.body.slice(0, 300)}`
          : (err as Error).message;
      this.logger.error(`Careem ${what} failed: ${message}`);
      throw new InternalServerErrorException({
        step: what,
        message,
        where: (err as Error).stack?.split("\n")[1]?.trim() ?? null,
      });
    }
  }

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
      "Careem rejected the client credentials themselves. We already retry with " +
      "every OAuth client-authentication style (body params and HTTP Basic), so " +
      "this is not the method. Check: (1) the id and secret pasted whole, with no " +
      "trailing whitespace — Careem shows them once and they are long; (2) these " +
      "are SANDBOX credentials, matching CAREEM_ENV=staging; (3) the credential " +
      "was fully generated — their dialog needs a webhook URL and key before it " +
      "issues one. Run the auth probe for a per-style breakdown."
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
