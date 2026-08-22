import * as fs from "fs";
import * as path from "path";
import { CustomersController } from "../customers.controller";

// Nest matches routes in DECLARATION order, so a literal path declared after a
// parameterised sibling is never reached: "lookup" would be swallowed by
// @Get(":customerId") and looked up as a customer id — a 404 that looks like
// "this customer has never ordered" rather than a routing mistake.
describe("GET /customers/lookup", () => {
  it("is declared before the :customerId route that would swallow it", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../customers.controller.ts"),
      "utf8",
    );
    // Anchored to the start of a line so the prose in the comment above the
    // route — which quotes @Get(":customerId") — is not mistaken for the
    // decorator itself.
    const at = (decorator: string) => {
      const m = new RegExp(`^\\s*${decorator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").exec(src);
      return m ? m.index : -1;
    };
    const lookup = at('@Get("lookup")');
    const byId = at('@Get(":customerId")');
    expect(lookup).toBeGreaterThan(-1);
    expect(byId).toBeGreaterThan(-1);
    expect(lookup).toBeLessThan(byId);
  });

  it("looks the number up against the caller's OWN tenant, never a supplied one", async () => {
    const customers: any = { lookupByPhone: jest.fn(async () => null) };
    const c = new CustomersController(customers, {} as any, {} as any);
    await c.lookup({ tenantId: "t1", userId: "u1", role: "MANAGER" } as any, "07788187123");
    expect(customers.lookupByPhone).toHaveBeenCalledWith("t1", "07788187123");
  });

  it("passes an empty string rather than undefined when no phone is given", async () => {
    const customers: any = { lookupByPhone: jest.fn(async () => null) };
    const c = new CustomersController(customers, {} as any, {} as any);
    await c.lookup({ tenantId: "t1" } as any, undefined);
    expect(customers.lookupByPhone).toHaveBeenCalledWith("t1", "");
  });
});
