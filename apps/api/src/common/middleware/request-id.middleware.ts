import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

// Attaches a request ID to every inbound request so log lines from a single
// HTTP call can be correlated even when they span multiple async operations.
// The ID is echoed back in the X-Request-Id response header so clients can
// include it in bug reports or support tickets.
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const requestId =
      (req.headers["x-request-id"] as string) ?? randomUUID();
    req.headers["x-request-id"] = requestId;
    res.setHeader("x-request-id", requestId);
    next();
  }
}
