import { Catch, ArgumentsHost, Logger, HttpException } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";

/**
 * Logs every failed response, then hands off to Nest's default handling.
 *
 * LoggingInterceptor only ever saw requests that reached a handler. In Nest,
 * guards run BEFORE interceptors, so everything the guards reject — 401 from
 * JwtAuthGuard, 403 from RolesGuard / DeviceLocationGuard / BillingGuard, 429
 * from UserThrottlerGuard — never reached it and was written to no log at all.
 *
 * The effect is a log that looks perfectly healthy while a client is being
 * turned away on every attempt: the kiosk's "Pay at the counter" POST left no
 * trace of any kind, and the same blindness sent an earlier rate-limit hunt to
 * the server log when the answer was only ever visible in the browser.
 *
 * This extends BaseExceptionFilter and delegates, so status codes and response
 * bodies stay byte-for-byte what they were — it only adds the log line.
 */
@Catch()
export class LoggingExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger("HTTP");

  override catch(exception: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest();
    const status =
      exception instanceof HttpException ? exception.getStatus() : 500;
    const message =
      exception instanceof HttpException
        ? JSON.stringify(exception.getResponse())
        : ((exception as Error)?.message ?? "unknown");
    const who = req?.user?.userId ? ` user=${req.user.userId}` : "";
    const line =
      `${req?.method} ${req?.originalUrl ?? req?.url} ${status}` +
      `${who} [${req?.id ?? "-"}] — ${message}`;
    if (status >= 500) this.logger.error(line);
    else this.logger.warn(line);

    super.catch(exception, host);
  }
}
