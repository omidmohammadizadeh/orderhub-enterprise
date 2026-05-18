import { Injectable, NestMiddleware, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request, Response, NextFunction } from "express";

// Paths that must remain accessible during maintenance (health probes, internal).
const ALLOWED_PATHS = [
  "/api/v1/health",
  "/api/v1/health/live",
  "/api/v1/health/ready",
];

@Injectable()
export class MaintenanceMiddleware implements NestMiddleware {
  constructor(private readonly config: ConfigService) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const isMaintenanceMode = this.config.get<boolean>("app.features.maintenanceMode") ?? false;

    if (!isMaintenanceMode) {
      return next();
    }

    const isAllowed = ALLOWED_PATHS.some((path) => req.path.startsWith(path));
    if (isAllowed) {
      return next();
    }

    const message =
      this.config.get<string>("app.features.maintenanceMessage") ??
      "The system is temporarily down for maintenance. Please try again shortly.";

    throw new ServiceUnavailableException({
      statusCode: 503,
      error: "Service Unavailable",
      message,
      maintenanceMode: true,
      retryAfter: 300, // seconds
    });
  }
}
