import { Injectable, Logger } from "@nestjs/common";

// A stand-in for Careem's API, so the integration can be run end to end
// before Careem issue us a client.
//
// This is not a stub that says 200 to everything. The point of the exercise is
// the parts of their API that are easy to get wrong, so the mock enforces the
// rules their documentation states and returns their error bodies verbatim:
//
//   * a branch is UNMAPPED when created, and a catalog push to an unmapped
//     branch fails with "branch_id is not mapped" — the wall every partner
//     hits first;
//   * a duplicate brand NAME is 409, not 200;
//   * DELETE /catalogs is deprecated and says so;
//   * a catalog over 8,500 items is rejected;
//   * more than 40 items in an availability call is rejected.
//
// Everything it receives is recorded, so what we actually sent can be read
// back and compared against their spec by eye.

export interface RecordedCall {
  at: string;
  method: string;
  path: string;
  brandId: string | null;
  branchId: string | null;
  userAgent: string | null;
  authorized: boolean;
  body: unknown;
  responseStatus: number;
  response: unknown;
}

export class CareemMockError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(typeof payload === "string" ? payload : JSON.stringify(payload));
  }
}

const validationError = (field: string, message: string) => ({
  message: "Validation Error",
  code: "VALIDATION_ERROR",
  error_type: "ValidationError",
  errors: [{ errors: [{ message }], field }],
});

@Injectable()
export class CareemSandboxService {
  private readonly logger = new Logger(CareemSandboxService.name);

  private readonly calls: RecordedCall[] = [];
  private readonly brands = new Map<string, { id: string; name: string }>();
  private readonly branches = new Map<
    string,
    {
      id: string;
      name: string;
      brand_id: string;
      state: "UNMAPPED" | "MAPPED";
      pos_integration: boolean;
      visibility: "active" | "inactive" | "offline";
    }
  >();
  private readonly catalogs = new Map<string, unknown>();
  private readonly catalogStatus = new Map<
    string,
    { catalog_id: string; status: string; reason: string | null }
  >();
  private requestSeq = 1;

  /** Only ever on when asked for, and never while pointed at Careem's real
   *  production API — a mock answering there would be indistinguishable from
   *  a working integration. */
  get enabled(): boolean {
    return (
      process.env.CAREEM_SANDBOX === "true" &&
      process.env.CAREEM_ENV !== "production"
    );
  }

  record(call: Omit<RecordedCall, "at">) {
    this.calls.unshift({ at: new Date().toISOString(), ...call });
    if (this.calls.length > 200) this.calls.pop();
  }

  recent(limit = 50): RecordedCall[] {
    return this.calls.slice(0, limit);
  }

  reset() {
    this.calls.length = 0;
    this.brands.clear();
    this.branches.clear();
    this.catalogs.clear();
    this.catalogStatus.clear();
    this.requestSeq = 1;
  }

  /** The step Careem's operations team does by hand, and the one that blocks
   *  everything else. Here it is a button. */
  mapBranch(branchId: string): { id: string; state: string } {
    const branch = this.branches.get(branchId);
    if (!branch) {
      throw new CareemMockError(404, {
        message: `branch ${branchId} does not exist — create it first`,
        code: "NOT_FOUND_ERROR",
      });
    }
    branch.state = "MAPPED";
    return { id: branch.id, state: branch.state };
  }

  snapshot() {
    return {
      // In memory and per-instance. Anything below is gone after a restart.
      volatile: true,
      brands: [...this.brands.values()],
      branches: [...this.branches.values()],
      catalogs: [...this.catalogs.keys()],
    };
  }

  catalogFor(branchId: string) {
    return this.catalogs.get(branchId) ?? null;
  }

  // ── The endpoints themselves ─────────────────────────────────────────────

  createBrand(body: { id?: string; name?: string }) {
    if (!body?.name?.trim()) {
      throw new CareemMockError(400, validationError("Name", "Name cannot be blank!"));
    }
    const clash = [...this.brands.values()].some(
      (b) => b.name === body.name && b.id !== body.id,
    );
    if (clash) {
      // Their flow diagram: uniqueness is on the NAME, and the answer is 409.
      throw new CareemMockError(409, {
        message: `brand with name ${body.name} already exists`,
        code: "CONFLICT_ERROR",
        error_type: "ConflictError",
      });
    }
    const brand = { id: String(body.id), name: body.name };
    this.brands.set(brand.id, brand);
    return brand;
  }

  listBrands(pageNumber = 1, pageSize = 20) {
    const all = [...this.brands.values()];
    const start = (pageNumber - 1) * pageSize;
    return { data: all.slice(start, start + pageSize), total: all.length };
  }

  putBranch(branchId: string, brandId: string | null, body: { name?: string }) {
    if (!body?.name?.trim()) {
      throw new CareemMockError(400, validationError("Name", "Name cannot be blank!"));
    }
    if (!brandId || !this.brands.has(brandId)) {
      throw new CareemMockError(
        400,
        validationError("Brand-Id", "brand does not exist — create the brand first"),
      );
    }
    const existing = this.branches.get(branchId);
    const branch = {
      id: branchId,
      name: body.name,
      brand_id: brandId,
      // A NEW branch is unmapped, and POS integration is off. Both are
      // Careem's defaults and both are why nothing works at first.
      state: existing?.state ?? ("UNMAPPED" as const),
      pos_integration: existing?.pos_integration ?? false,
      visibility: existing?.visibility ?? ("active" as const),
    };
    this.branches.set(branchId, branch);
    return branch;
  }

  listBranches(brandId: string | null, pageNumber = 1, pageSize = 20) {
    const all = [...this.branches.values()].filter(
      (b) => !brandId || b.brand_id === brandId,
    );
    const start = (pageNumber - 1) * pageSize;
    return { data: all.slice(start, start + pageSize), total: all.length };
  }

  setPos(branchId: string, active: boolean) {
    const branch = this.mustBranch(branchId);
    branch.pos_integration = active;
    return { id: branch.id, active };
  }

  setVisibility(branchId: string, statusId: number, tillMinutes?: number) {
    const branch = this.mustBranch(branchId);
    if (branch.visibility === "offline") {
      // Their read endpoint returns can_reactivate: false for a reason —
      // a partner cannot climb out of offline.
      throw new CareemMockError(403, {
        message: "branch is offline and can only be reactivated by Careem operations",
        code: "FORBIDDEN_ERROR",
        error_type: "ForbiddenError",
      });
    }
    branch.visibility = statusId === 1 ? "active" : "inactive";
    return {
      id: branch.id,
      status: branch.visibility,
      ...(tillMinutes ? { till_time: tillMinutes } : {}),
    };
  }

  getVisibility(branchId: string) {
    const branch = this.mustBranch(branchId);
    return {
      status: branch.visibility,
      reason: branch.visibility === "offline" ? "suspended by operations" : null,
      can_reactivate: branch.visibility !== "offline",
    };
  }

  putHours(branchId: string, body: { operational_hours?: unknown[] }) {
    const branch = this.mustBranch(branchId);
    const hours = body?.operational_hours;
    if (!Array.isArray(hours)) {
      throw new CareemMockError(
        400,
        validationError("operational_hours", "operational_hours is required"),
      );
    }
    for (const day of hours as Array<Record<string, any>>) {
      for (const shift of day?.shifts ?? []) {
        // Stated plainly in their docs, and the kind of thing that is only
        // discovered when a real push fails.
        if (shift?.end_time === "00:00") {
          throw new CareemMockError(
            400,
            validationError("end_at", "end_at cannot be 00:00"),
          );
        }
      }
    }
    return { id: branch.id, operational_hours: hours };
  }

  putCatalog(branchId: string, body: any) {
    const branch = this.mustBranch(branchId);
    if (branch.state !== "MAPPED") {
      // The error every partner meets first, verbatim from their FAQ.
      throw new CareemMockError(
        400,
        validationError("branch_id", "branch_id is not mapped"),
      );
    }
    if (!body?.catalog?.currency_id) {
      throw new CareemMockError(
        400,
        validationError("currency_id", "currency_id is required"),
      );
    }
    const items = body?.items ?? [];
    if (items.length > 8500) {
      throw new CareemMockError(400, {
        message: "catalog exceeds the maximum of 8500 items",
        code: "VALIDATION_ERROR",
        error_type: "ValidationError",
      });
    }
    this.catalogs.set(branchId, body);
    const requestId = `sandbox-req-${this.requestSeq++}`;
    this.catalogStatus.set(requestId, {
      catalog_id: String(body?.catalog?.id ?? branchId),
      status: "SUCCESS",
      reason: null,
    });
    return { request_id: requestId, created_at: new Date().toISOString() };
  }

  catalogStatusFor(requestId: string) {
    const status = this.catalogStatus.get(requestId);
    if (!status) {
      throw new CareemMockError(404, {
        message: `request ${requestId} not found`,
        code: "NOT_FOUND_ERROR",
      });
    }
    return status;
  }

  deleteCatalog() {
    // Deprecated on their side since 24 April 2024.
    throw new CareemMockError(400, {
      message: "Api deprecated Error",
      code: "API_DEPRECATED_ERROR",
      error_type: "APIDeprecatedError",
      errors: null,
    });
  }

  patchItems(body: { items?: unknown[] }) {
    const items = body?.items ?? [];
    if (items.length > 40) {
      throw new CareemMockError(400, {
        message: "no more than 40 items can be updated in a single call",
        code: "VALIDATION_ERROR",
        error_type: "ValidationError",
      });
    }
    return { updated: items.length };
  }

  private mustBranch(branchId: string) {
    const branch = this.branches.get(branchId);
    if (!branch) {
      // The sandbox lives in memory, so every deploy and every restart empties
      // it. Saying so here saves the reader diagnosing a 404 that only means
      // "the API restarted since you ran step 2".
      throw new CareemMockError(404, {
        message:
          `branch ${branchId} does not exist. The sandbox is in memory and is ` +
          `emptied by any API restart — re-run "Onboard the shop" to recreate it.`,
        code: "NOT_FOUND_ERROR",
        error_type: "NotFoundError",
      });
    }
    return branch;
  }
}
