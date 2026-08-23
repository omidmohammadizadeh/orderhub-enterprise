import {
  All,
  Body,
  Controller,
  Headers,
  HttpException,
  Logger,
  NotFoundException,
  Param,
  Query,
  Req,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request } from "express";
import { Public } from "../../../common/decorators/public.decorator";
import {
  CareemMockError,
  CareemSandboxService,
} from "./careem-sandbox.service";

// Careem's API, answering on our own server.
//
// Point CAREEM_API_BASE at this controller and every outbound call the
// integration makes runs for real — real URLs, real headers, real bodies, real
// error handling — without a Careem client. It is the only way to exercise the
// outbound half before they issue one.
//
//   CAREEM_SANDBOX=true
//   CAREEM_API_BASE=https://<our-api>/api/v1/careem-mock
//
// Public because our own client authenticates with a Bearer token this
// controller issued, not with our JWT. It records whether that header was
// present so a missing Authorization shows up as a finding rather than
// passing silently.
@ApiExcludeController()
@Public()
@Controller({ path: "careem-mock", version: "1" })
export class CareemMockController {
  private readonly logger = new Logger(CareemMockController.name);

  constructor(private readonly sandbox: CareemSandboxService) {}

  @All("*")
  async handle(
    @Req() req: Request,
    @Body() body: unknown,
    @Headers("authorization") auth: string | undefined,
    @Headers("user-agent") userAgent: string | undefined,
    @Headers("brand-id") brandId: string | undefined,
    @Headers("branch-id") branchId: string | undefined,
    @Query() query: Record<string, string>,
  ) {
    if (!this.sandbox.enabled) throw new NotFoundException();

    const method = req.method;
    const path = "/" + (req.params[0] ?? "");
    let status = 200;
    let response: unknown;

    try {
      response = this.route(method, path, body, brandId, branchId, query, auth);
    } catch (err) {
      if (err instanceof CareemMockError) {
        status = err.status;
        response = err.payload;
      } else {
        status = 500;
        response = { message: (err as Error).message };
      }
    }

    this.sandbox.record({
      method,
      path,
      brandId: brandId ?? null,
      branchId: branchId ?? null,
      // Careem require a User-Agent on every endpoint. Recording it is how a
      // regression there becomes visible instead of mysterious.
      userAgent: userAgent ?? null,
      authorized: !!auth?.startsWith("Bearer "),
      body: method === "GET" ? null : body,
      responseStatus: status,
      response,
    });

    if (status >= 400) throw new HttpException(response as never, status);
    return response;
  }

  private route(
    method: string,
    path: string,
    body: any,
    brandId: string | undefined,
    branchId: string | undefined,
    query: Record<string, string>,
    auth: string | undefined,
  ): unknown {
    const page = Number(query.page_number) || 1;
    const size = Math.min(20, Number(query.page_size) || 20);

    if (method === "POST" && path === "/token") {
      return {
        access_token: `sandbox.${Buffer.from(String(Date.now())).toString("base64url")}`,
        token_type: "Bearer",
        // Theirs is 24 hours.
        expires_in: 86_400,
        scope: "pos",
      };
    }

    // Everything past the token needs one, exactly as theirs does.
    if (!auth?.startsWith("Bearer ")) {
      throw new CareemMockError(401, {
        message: "Full authentication is required to access this resource",
        code: "UNAUTHORIZED",
        error_type: "UnauthorizedError",
      });
    }

    if (method === "POST" && path === "/brands") return this.sandbox.createBrand(body);
    if (method === "GET" && path === "/brands") return this.sandbox.listBrands(page, size);

    const branchMatch = /^\/branches\/([^/]+)(\/.*)?$/.exec(path);
    if (branchMatch) {
      const id = decodeURIComponent(branchMatch[1]!);
      const rest = branchMatch[2] ?? "";
      if (method === "PUT" && !rest)
        return this.sandbox.putBranch(id, brandId ?? null, body);
      if (method === "PATCH" && rest === "/status")
        return this.sandbox.setPos(id, !!body?.active);
      if (method === "POST" && rest === "/visibility/status")
        return this.sandbox.setVisibility(id, Number(body?.status_id));
      if (method === "GET" && rest === "/visibility/status")
        return this.sandbox.getVisibility(id);
      if (method === "POST" && rest === "/visibility/status/expiries")
        return this.sandbox.setVisibility(
          id,
          Number(body?.status_id),
          Number(body?.till_time),
        );
    }
    if (method === "GET" && path === "/branches")
      return this.sandbox.listBranches(brandId ?? null, page, size);

    if (method === "PUT" && path === "/operational-hours") {
      if (!branchId) {
        throw new CareemMockError(400, { message: "Branch-Id header is required" });
      }
      return this.sandbox.putHours(branchId, body);
    }

    if (path === "/catalogs") {
      if (method === "PUT") {
        if (!branchId) {
          throw new CareemMockError(400, { message: "Branch-Id header is required" });
        }
        return this.sandbox.putCatalog(branchId, body);
      }
      if (method === "DELETE") return this.sandbox.deleteCatalog();
    }
    const statusMatch = /^\/catalogs\/status\/([^/]+)$/.exec(path);
    if (method === "GET" && statusMatch)
      return this.sandbox.catalogStatusFor(decodeURIComponent(statusMatch[1]!));
    if (method === "PATCH" && /^\/catalogs\/[^/]+\/items$/.test(path))
      return this.sandbox.patchItems(body);

    // Orders. Nothing to keep — what matters is that our accept/ready/cancel
    // reached the right URL with the right body, and the recording shows that.
    if (/^\/orders\/[^/]+$/.test(path) && method === "PUT")
      return { id: path.split("/")[2], status: body?.state ?? body?.status };
    if (/^\/orders\/[^/]+\/delay-request$/.test(path) && method === "PUT")
      return { accepted: true, delay_in_minutes: body?.delay_in_minutes };
    if (/^\/orders\/[^/]+\/tags$/.test(path) && method === "PATCH")
      return { tagged: body?.tag };

    throw new CareemMockError(404, {
      message: `no sandbox route for ${method} ${path}`,
      code: "NOT_FOUND_ERROR",
      error_type: "NotFoundError",
    });
  }
}
