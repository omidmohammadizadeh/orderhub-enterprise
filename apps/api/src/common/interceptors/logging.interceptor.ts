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
          `${method} ${url} ${status} ${ms}ms${requestId ? ` [${requestId}]` : ""} — ${err?.message}`,
        );
        return throwError(() => err);
      }),
    );
  }
}
