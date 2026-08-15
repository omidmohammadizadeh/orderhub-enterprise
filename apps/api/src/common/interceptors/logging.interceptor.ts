import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from "@nestjs/common";
import { Observable, tap, catchError, throwError } from "rxjs";
import { Request, Response } from "express";

// Logs every HTTP request with timing, status code, and request ID so we
// can trace the full webhook → ingest → worker chain from structured logs.
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("HTTP");

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const { method, url } = req;
    const requestId = req.headers["x-request-id"] as string | undefined;
    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        const ms = Date.now() - start;
        const status = res.statusCode;
        this.logger.log(
          `${method} ${url} ${status} ${ms}ms${requestId ? ` [${requestId}]` : ""}`,
        );
      }),
      catchError((err) => {
        const ms = Date.now() - start;
        const status = err?.status ?? 500;
        this.logger.warn(
          `${method} ${url} ${status} ${ms}ms${requestId ? ` [${requestId}]` : ""} — ${describeError(err)}`,
        );
        return throwError(() => err);
      }),
    );
  }
}

/**
 * What actually went wrong, not just the exception's class name.
 *
 * A failed ValidationPipe throws a BadRequestException whose `.message` is the
 * literal string "Bad Request Exception" — the field that failed lives in the
 * response body instead. Logging only `.message` meant every validation
 * failure in production read identically and told you nothing: an operator
 * reported a save that wouldn't work and the log said "Bad Request Exception"
 * four times with no clue which field was at fault.
 *
 * Only the constraint messages are logged, never the body. Those name the
 * property and the rule it broke, which is the whole diagnosis, and they carry
 * none of the customer data a request body would.
 */
export function describeError(err: any): string {
  const body =
    typeof err?.getResponse === "function" ? err.getResponse() : undefined;
  const detail = (body as any)?.message;
  if (Array.isArray(detail) && detail.length) {
    const shown = detail.slice(0, 5).join("; ");
    const more = detail.length > 5 ? ` (+${detail.length - 5} more)` : "";
    return `${err?.message}: ${shown}${more}`;
  }
  if (typeof detail === "string" && detail !== err?.message) {
    return `${err?.message}: ${detail}`;
  }
  return String(err?.message ?? "unknown error");
}
