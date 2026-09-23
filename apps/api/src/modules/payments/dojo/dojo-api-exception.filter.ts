import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from "@nestjs/common";
import type { Response } from "express";
import { DojoApiError } from "./dojo-api.client";

/**
 * A refusal from Dojo is not a crash in us. Without this, a Dojo 400 reached
 * the till as "Internal server error" with no clue what Dojo objected to
 * (refunds, 2026-09-23), and every 4xx looked like a bug in OrderHub.
 *
 * Dojo's own status is only passed through when it means the same thing to our
 * caller. A Dojo 401/403 must NOT become our 401: the dashboard treats that as
 * an expired session and would silently log the operator out — or spin in a
 * token-refresh loop — over a bad API key at ONE location.
 */
const PASS_THROUGH = new Set([
  HttpStatus.BAD_REQUEST,
  HttpStatus.CONFLICT,
  HttpStatus.UNPROCESSABLE_ENTITY,
]);

@Catch(DojoApiError)
export class DojoApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DojoApiExceptionFilter.name);

  catch(err: DojoApiError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const status = PASS_THROUGH.has(err.status) ? err.status : HttpStatus.BAD_GATEWAY;
    const message =
      err.status === HttpStatus.UNAUTHORIZED || err.status === HttpStatus.FORBIDDEN
        ? "Dojo refused the request. Check this location's Dojo API key on the Card readers page."
        : err.message;

    this.logger.warn(`${err.message} (body: ${JSON.stringify(err.body ?? null).slice(0, 500)})`);
    res.status(status).json({ statusCode: status, error: "Dojo", message });
  }
}
