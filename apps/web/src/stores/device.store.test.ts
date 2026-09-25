// Which physical device a till drives.
//
// Two tills in one shop share a Dojo account and a set of printers. Before
// pinning, each tablet picked "the first available machine" and printed to
// every counter printer — so till B could send its total to the machine a
// customer was already standing at, and pop till A's cash drawer open.
//
// Getting "which machine" wrong moves money to the wrong counter. Getting
// "which printers" wrong silently stops the kitchen copy, which is worse than
// the bug being fixed. Both rules are pinned here.

import { beforeEach, describe, expect, it } from "vitest";
import {
  chooseCardMachine,
  chooseReceiptPrinters,
  pinnedCardMachine,
  pinnedPrinter,
  useDeviceStore,
} from "./device.store";

const TERMINALS = [
  { id: "tm_A", status: "Available" },
  { id: "tm_B", status: "Available" },
];

const PRINTERS = [
  { id: "p_counterA", kind: "FRONT_COUNTER" },
  { id: "p_counterB", kind: "FRONT_COUNTER" },
  { id: "p_kitchen", kind: "KITCHEN" },
];

beforeEach(() => {
  useDeviceStore.setState({ cardMachineByLocation: {}, printerByLocation: {} });
});

describe("card machine per tablet", () => {
  it("charges to the machine this tablet pinned, not the first free one", () => {
    expect(chooseCardMachine(TERMINALS, "tm_B")?.id).toBe("tm_B");
  });

  it("refuses to guess when there are two machines and no pin", () => {
    // The old behaviour picked the first Available here, which is exactly how
    // one till's total reached the other till's customer.
    expect(chooseCardMachine(TERMINALS, null)).toBeNull();
  });

  it("doesn't ask when the shop only has one machine", () => {
    expect(chooseCardMachine([TERMINALS[0]!], null)?.id).toBe("tm_A");
  });

  it("goes back to asking if the pinned machine is gone", () => {
    // Unplugged, removed from the Dojo account, or swapped for a new one.
    expect(chooseCardMachine(TERMINALS, "tm_RETIRED")).toBeNull();
  });

  it("keeps each location's pin separate on the same tablet", () => {
    const { setCardMachine } = useDeviceStore.getState();
    setCardMachine("loc-1", "tm_A");
    setCardMachine("loc-2", "tm_B");
    expect(pinnedCardMachine("loc-1")).toBe("tm_A");
    expect(pinnedCardMachine("loc-2")).toBe("tm_B");
    // A tablet never used at a third site has no opinion about it.
    expect(pinnedCardMachine("loc-3")).toBeNull();
    expect(pinnedCardMachine(null)).toBeNull();
  });
});

describe("receipt printers per tablet", () => {
  it("prints to this till's counter and still to the kitchen", () => {
    const ids = chooseReceiptPrinters(PRINTERS, "p_counterB").map((p) => p.id);
    expect(ids).toEqual(["p_counterB", "p_kitchen"]);
  });

  it("never silences the kitchen, whichever counter is pinned", () => {
    for (const pin of ["p_counterA", "p_counterB"]) {
      expect(chooseReceiptPrinters(PRINTERS, pin).map((p) => p.id)).toContain("p_kitchen");
    }
  });

  it("prints everywhere when nothing is pinned — unchanged behaviour", () => {
    expect(chooseReceiptPrinters(PRINTERS, null)).toHaveLength(3);
  });

  it("prints everywhere when the pinned printer has been removed", () => {
    // A duplicate receipt is a nuisance; a missing one is a lost order.
    expect(chooseReceiptPrinters(PRINTERS, "p_gone")).toHaveLength(3);
  });

  it("clears a pin back to unset", () => {
    const { setPrinter } = useDeviceStore.getState();
    setPrinter("loc-1", "p_counterA");
    expect(pinnedPrinter("loc-1")).toBe("p_counterA");
    setPrinter("loc-1", null);
    expect(pinnedPrinter("loc-1")).toBeNull();
  });
});
