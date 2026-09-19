import { CustomersService } from "../customers.service";

// The Customers page channel dropdown sends a channel id; the directory maps
// it to the orderSource values that channel writes. An id missing from that
// map is silently IGNORED — the filter drops out and every customer comes
// back — so "Careem" or "AI Voice" showed the whole list, labelled as if it
// were filtered.

function harness() {
  const svc = Object.create(CustomersService.prototype) as any;
  svc.accessibleLocationIds = jest.fn().mockResolvedValue(null);
  svc.prisma = { order: { findMany: jest.fn().mockResolvedValue([]) } };
  return svc;
}

async function whereFor(channel: string) {
  const svc = harness();
  await svc.directory("t1", { channel }).catch(() => undefined);
  return svc.prisma.order.findMany.mock.calls[0][0].where;
}

describe("Customers directory — channel filter", () => {
  it.each([
    ["CAREEM", ["CAREEM"]],
    ["TALABAT", ["TALABAT"]],
    ["VOICE", ["VOICE"]],
    ["GLOVO", ["GLOVO"]],
  ])("filters %s to its own orders", async (channel, sources) => {
    expect((await whereFor(channel)).orderSource).toEqual({ in: sources });
  });

  it("leaves the existing channels as they were", async () => {
    expect((await whereFor("ONLINE")).orderSource).toEqual({
      in: ["ONLINE", "DIRECT"],
    });
    expect((await whereFor("DELIVEROO")).orderSource).toEqual({
      in: ["DELIVEROO"],
    });
  });

  it("applies no channel filter for All channels", async () => {
    expect((await whereFor("ALL")).orderSource).toBeUndefined();
  });
});
