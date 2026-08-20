import { JetOrderModificationService } from "../jet-order-modification.service";

// JE-6 — out-of-stock and substitutions.
//
// Two behaviours carry most of the weight here. First, the structural rules
// (one-for-one, matching quantities) are enforced BEFORE the call so the
// operator gets a sentence they can act on instead of an enum code after a
// round trip. Second, the validation endpoint answers 200 even when it is
// rejecting — the errors live in the body, so reading the status alone would
// report every invalid substitution as fine.

const ORDER = {
  id: "order-1",
  tenantId: "tenant-1",
  brandId: "brand-1",
  locationId: "location-1",
  externalId: "00025doahk2txeo9ttd0ma",
  displayId: "22721763",
  status: "PREPARING",
};

const USER = {
  userId: "u1",
  tenantId: "tenant-1",
  role: "MANAGER",
  permissions: [],
} as any;

function makeService(
  opts: { order?: any; access?: any; request?: jest.Mock } = {},
) {
  const request = opts.request ?? jest.fn().mockResolvedValue({ errors: [] });
  const prisma = {
    order: {
      findFirst: jest.fn(async () =>
        opts.order === undefined ? ORDER : opts.order,
      ),
    },
  } as any;
  const orders = {
    resolveOrderAccessWhere: jest.fn(async () =>
      "access" in opts ? opts.access : { tenantId: "tenant-1" },
    ),
  } as any;
  const activity = { record: jest.fn() } as any;
  return {
    service: new JetOrderModificationService(
      prisma,
      orders,
      { request } as any,
      activity,
    ),
    request,
    prisma,
    orders,
    activity,
  };
}

const oneForOne = [
  { removedItems: [{ plu: "plu123", missingQuantity: 1 }], addedItems: [{ plu: "plu321", quantity: 1 }] },
];

describe("structuralProblems", () => {
  const check = JetOrderModificationService.structuralProblems;

  it("accepts a straight removal with no substitute", () => {
    expect(check([{ removedItems: [{ plu: "p", missingQuantity: 2 }] }])).toEqual([]);
  });

  it("accepts a matched one-for-one substitution", () => {
    expect(check(oneForOne)).toEqual([]);
    expect(
      check([
        {
          removedItems: [{ plu: "p", missingQuantity: 2 }],
          addedItems: [{ plu: "q", quantity: 2 }],
        },
      ]),
    ).toEqual([]);
  });

  it("rejects many-to-one and says how to fix it", () => {
    const problems = check([
      {
        removedItems: [
          { plu: "a", missingQuantity: 1 },
          { plu: "b", missingQuantity: 1 },
        ],
        addedItems: [{ plu: "c", quantity: 2 }],
      },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("separate changes");
  });

  it("rejects one-to-many", () => {
    const problems = check([
      {
        removedItems: [{ plu: "a", missingQuantity: 2 }],
        addedItems: [
          { plu: "b", quantity: 1 },
          { plu: "c", quantity: 1 },
        ],
      },
    ]);
    expect(problems[0]).toContain("ONE replacement");
  });

  it("rejects a quantity mismatch — 2x500ml for 1x1L is not supported", () => {
    // The spec's own worked counter-example.
    const problems = check([
      {
        removedItems: [{ plu: "500ml", missingQuantity: 2 }],
        addedItems: [{ plu: "1L", quantity: 1 }],
      },
    ]);
    expect(problems[0]).toContain("must match");
    expect(problems[0]).toContain("500ml");
  });

  it("catches the same item marked out of stock twice", () => {
    const problems = check([
      { removedItems: [{ plu: "a", missingQuantity: 1 }] },
      { removedItems: [{ plu: "a", missingQuantity: 1 }] },
    ]);
    expect(problems[0]).toContain("already marked out of stock");
  });

  it("rejects an empty or malformed request", () => {
    expect(check([])).toHaveLength(1);
    expect(check([{ removedItems: [] }])[0]).toContain("nothing was marked");
    expect(check([{ removedItems: [{ plu: "", missingQuantity: 1 }] }])[0]).toContain(
      "no PLU",
    );
    expect(check([{ removedItems: [{ plu: "a", missingQuantity: 0 }] }])[0]).toContain(
      "at least 1",
    );
  });
});

describe("JetOrderModificationService.validate", () => {
  it("posts to the validation endpoint with the ORDER key", async () => {
    const { service, request } = makeService();
    await service.validate(USER, "order-1", oneForOne);

    const [method, path, opts] = request.mock.calls[0]!;
    expect(method).toBe("POST");
    expect(path).toBe("/orders/00025doahk2txeo9ttd0ma/validation");
    expect(opts.keyType).toBe("order");
    expect(opts.body).toEqual({ modifications: oneForOne });
  });

  it("treats a 200 carrying errors as a REJECTION", async () => {
    // The endpoint's whole job is returning the errors the real call would
    // have produced. Reading only the HTTP status reports every invalid
    // substitution as valid.
    const request = jest.fn().mockResolvedValue({
      orderId: "x",
      errors: [{ errorCode: "addedItemNotFound", added: { plu: "plu321" } }],
    });
    const { service } = makeService({ request });
    const result = await service.validate(USER, "order-1", oneForOne);

    expect(result.valid).toBe(false);
    expect(result.problems[0]).toContain("plu321");
    expect(result.problems[0]).toContain("published menu");
  });

  it("does not spend a round trip on a structurally impossible change", async () => {
    const { service, request } = makeService();
    const result = await service.validate(USER, "order-1", [
      {
        removedItems: [{ plu: "a", missingQuantity: 2 }],
        addedItems: [{ plu: "b", quantity: 1 }],
      },
    ]);
    expect(result.valid).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("JetOrderModificationService.submit", () => {
  it("validates before applying", async () => {
    // A rejected modification leaves the order in limbo mid-service while the
    // kitchen waits to be told what to make.
    const { service, request } = makeService();
    await service.submit(USER, "order-1", oneForOne);

    expect(request.mock.calls[0]![1]).toContain("/validation");
    expect(request.mock.calls[1]![1]).toBe(
      "/orders/00025doahk2txeo9ttd0ma/modification",
    );
  });

  it("refuses when JET says it would reject the change", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({ errors: [{ errorCode: "removedItemSubstitutionNotEnabled" }] });
    const { service } = makeService({ request });
    await expect(service.submit(USER, "order-1", oneForOne)).rejects.toThrow(
      /didn't allow substitutions/i,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refuses a structurally invalid change with a readable message", async () => {
    const { service, request } = makeService();
    await expect(
      service.submit(USER, "order-1", [
        {
          removedItems: [{ plu: "500ml", missingQuantity: 2 }],
          addedItems: [{ plu: "1L", quantity: 1 }],
        },
      ]),
    ).rejects.toThrow(/must match/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("reports pending, because JET applies it asynchronously", async () => {
    const { service, activity } = makeService();
    const result = await service.submit(USER, "order-1", oneForOne);
    expect(result).toMatchObject({ ok: true, pending: true });
    expect(result.summary).toBe("1× plu123 → 1× plu321");
    expect(activity.record.mock.calls[0]![0].status).toBe("INFO");
  });
});

describe("JetOrderModificationService — access scoping", () => {
  it("refuses when the user can see no orders at all", async () => {
    // A null access filter means NO access. Falling back to a tenant-wide
    // lookup here is exactly the leak the orders board already suffered.
    const { service, prisma } = makeService({ access: null });
    await expect(service.validate(USER, "order-1", oneForOne)).rejects.toThrow(
      /don't have access/i,
    );
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it("composes the access filter with AND, never spreading it", async () => {
    // Spreading `access` into a literal that declares its own clauses is how
    // the live board lost its scoping — a later key silently replaced the
    // allowlist.
    const { service, prisma } = makeService();
    await service.validate(USER, "order-1", oneForOne);
    const where = prisma.order.findFirst.mock.calls[0]![0].where;
    expect(where.AND).toEqual([
      { tenantId: "tenant-1" },
      { id: "order-1", platform: "JUST_EAT" },
    ]);
  });

  it("404s an order outside the user's scope", async () => {
    const { service } = makeService({ order: null });
    await expect(service.validate(USER, "order-1", oneForOne)).rejects.toThrow(
      /not found/i,
    );
  });

  it("refuses an order with no Just Eat reference", async () => {
    const { service } = makeService({ order: { ...ORDER, externalId: null } });
    await expect(service.validate(USER, "order-1", oneForOne)).rejects.toThrow(
      /no Just Eat reference/i,
    );
  });
});

describe("JetOrderModificationService.handleModificationCallback", () => {
  it("records a success", async () => {
    const { service, activity } = makeService();
    const result = await service.handleModificationCallback({
      orderId: "00025doahk2txeo9ttd0ma",
      type: "modification",
    });
    expect(result.handled).toBe(true);
    expect(activity.record.mock.calls[0]![0].status).toBe("SUCCESS");
  });

  it("translates the failure code into something actionable", async () => {
    const { service, activity } = makeService();
    await service.handleModificationCallback({
      orderId: "00025doahk2txeo9ttd0ma",
      errors: [
        {
          errorCode: "addedPriceIsGreaterThanRemoved",
          pricing: { currency: "GBP", priceDifference: 150 },
        },
      ],
    });
    const entry = activity.record.mock.calls[0]![0];
    expect(entry.status).toBe("ERROR");
    expect(entry.message).toContain("costs more");
    expect(entry.message).toContain("150");
  });

  it("explains a one-for-one violation in the operator's words", async () => {
    const { service, activity } = makeService();
    await service.handleModificationCallback({
      orderId: "00025doahk2txeo9ttd0ma",
      errors: [
        { errorCode: "notSupported", notSupportedReasons: ["manyToOneSubstitution"] },
      ],
    });
    expect(activity.record.mock.calls[0]![0].message).toContain("one-for-one");
  });

  it("passes an unknown code through instead of guessing", async () => {
    // JET's own note says the enum may grow and applications must tolerate
    // new values. A wrong guess sends the operator somewhere useless.
    const { service, activity } = makeService();
    await service.handleModificationCallback({
      orderId: "00025doahk2txeo9ttd0ma",
      errors: [{ errorCode: "somethingBrandNew" }],
    });
    expect(activity.record.mock.calls[0]![0].message).toContain("somethingBrandNew");
  });

  it("ignores a callback for an order we do not have", async () => {
    const { service } = makeService({ order: null });
    await expect(
      service.handleModificationCallback({ orderId: "unknown" }),
    ).resolves.toMatchObject({ handled: false });
  });
});
