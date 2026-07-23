import { AGENT_TOOLS, AGENT_TOOL_MAP } from "../agent.tools";

// Minimal Prisma stub — records the `where` each tool builds so we can assert
// tenant scoping without a database.
function stubPrisma(data: Record<string, any[]>) {
  const calls: any[] = [];
  const model = (rows: any[]) => ({
    findMany: async (args: any) => {
      calls.push(args);
      return rows;
    },
    findFirst: async (args: any) => {
      calls.push(args);
      return rows[0] ?? null;
    },
  });
  return {
    calls,
    prisma: {
      brand: model(data.brand ?? [{ id: "b1" }, { id: "b2" }]),
      location: model(data.location ?? []),
      menu: model(data.menu ?? []),
      menuItem: model(data.menuItem ?? []),
      order: model(data.order ?? []),
    } as any,
  };
}

describe("agent tool registry (read-only)", () => {
  it("every tool has a name, description, schema and run()", () => {
    for (const t of AGENT_TOOLS) {
      expect(typeof t.name).toBe("string");
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.input_schema).toBeTruthy();
      expect(typeof t.run).toBe("function");
    }
    expect(Object.keys(AGENT_TOOL_MAP).length).toBe(AGENT_TOOLS.length);
  });

  it("list_orders scopes strictly to the caller's tenantId", async () => {
    const { prisma, calls } = stubPrisma({});
    await AGENT_TOOL_MAP["list_orders"].run(prisma, "tenant-42", {});
    const where = calls[calls.length - 1].where;
    expect(where.tenantId).toBe("tenant-42");
  });

  it("search_products scopes to the tenant's own brand ids only", async () => {
    const { prisma, calls } = stubPrisma({ brand: [{ id: "b1" }, { id: "b2" }] });
    await AGENT_TOOL_MAP["search_products"].run(prisma, "tenant-42", { query: "burger" });
    const where = calls[calls.length - 1].where;
    expect(where.brandId).toEqual({ in: ["b1", "b2"] });
    expect(where.name).toEqual({ contains: "burger", mode: "insensitive" });
  });

  it("ignores any tenantId the model tries to pass in input", async () => {
    const { prisma, calls } = stubPrisma({});
    await AGENT_TOOL_MAP["list_orders"].run(prisma, "tenant-42", {
      tenantId: "tenant-EVIL",
    } as any);
    expect(calls[calls.length - 1].where.tenantId).toBe("tenant-42");
  });
});
