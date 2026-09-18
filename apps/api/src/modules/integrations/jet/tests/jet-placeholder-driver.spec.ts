import { transformJetOrder } from "../jet-order.transformer";
import { DELIVERY_BY_PARTNER } from "./jet-order.fixtures";

// Just Eat fills `driver` before any real courier is assigned.
//
// Real envelope, order wgx7eqbm4kqgxkgisfxt6g (2026-09-18):
//   "driver": { "first_name": "Order", "last_name": "wgx7eqbm4kqgxkgisfxt6g",
//               "phone_number": "00000000000" }
//
// We copied that onto the courier columns, so the board's Rider column read
// "Order wgx7eqbm…" and the drawer offered 00000000000 as the courier's
// number — which looks like a driver was assigned when none was.

function withDriver(driver: unknown, id = "wgx7eqbm4kqgxkgisfxt6g") {
  return { ...(DELIVERY_BY_PARTNER as any), id, driver };
}

describe("JET placeholder driver", () => {
  it("drops the placeholder Just Eat sends before a courier is assigned", () => {
    const c = transformJetOrder(
      withDriver({
        first_name: "Order",
        last_name: "wgx7eqbm4kqgxkgisfxt6g",
        phone_number: "00000000000",
      }),
    )!.canonical;
    expect((c.metadata as any).courier).toBeUndefined();
  });

  it("drops an all-zero phone even when a name is present", () => {
    const c = transformJetOrder(
      withDriver({ first_name: "Sam", last_name: "Rider", phone_number: "000 0000 0000" }),
    )!.canonical;
    expect((c.metadata as any).courier).toEqual({
      name: "Sam Rider",
      phone: null,
      phoneAccessCode: null,
    });
  });

  it("still keeps a real driver", () => {
    const c = transformJetOrder(
      withDriver({ first_name: "John", last_name: "Smith", phone_number: "555-111-3344" }),
    )!.canonical;
    expect((c.metadata as any).courier).toEqual({
      name: "John Smith",
      phone: "555-111-3344",
      phoneAccessCode: null,
    });
  });
});
