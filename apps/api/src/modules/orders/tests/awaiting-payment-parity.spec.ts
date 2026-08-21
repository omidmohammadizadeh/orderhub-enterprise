import * as fs from "fs";
import * as path from "path";

// The hold rule ("are WE still collecting for this order?") drifted across
// five separate copies, and each round of fixes patched some and missed
// others. Walk-in cash was added to three places and STILL printed unpaid
// tickets, because the one that actually drives the printer had no payment
// check at all.
//
// apps/web has no test harness, so this guards the structure from the API
// suite: one definition, every consumer importing it, no inline copies.

const WEB = path.join(__dirname, "../../../../../web/src");
const read = (p: string) => fs.readFileSync(path.join(WEB, p), "utf8");

const CONSUMERS = [
  "hooks/use-bridge-auto-print.ts",
  "hooks/use-auto-accept.ts",
  "components/orders/order-board.tsx",
  "components/orders/order-list.tsx",
  "app/(dashboard)/dashboard/pos/page.tsx",
];

describe("the payment-hold rule has exactly one definition", () => {
  it("defines the walk-in cash case once, in the shared module", () => {
    const src = read("lib/orders/awaiting-payment.ts");
    expect(src).toContain('o.isWalkIn === true && method === "CASH"');
    expect(src).toContain('method === "PAYMENT_LINK"');
    expect(src).toContain('method === "CARD_TERMINAL"');
  });

  it("is used by every path that can accept or print an order", () => {
    for (const f of CONSUMERS) {
      expect(read(f)).toContain("isAwaitingOurPayment");
    }
  });

  it("guards the AUTO-PRINT hook, which prints independently of accepting", () => {
    // This is the one that was missed: accepting and printing are separate
    // pipelines, and every earlier fix only held the accept side.
    const src = read("hooks/use-bridge-auto-print.ts");
    expect(src).toContain("if (isAwaitingOurPayment(o as any)) continue;");
  });

  it("leaves no inline re-implementation in the accept/print/display paths", () => {
    // A local copy is how the rule drifted in the first place.
    //
    // The POS page is deliberately exempt: it still names payment methods to
    // decide WHICH modal to pop after placement (cash keypad vs reader charge
    // vs payment link). That is a routing decision, not a hold decision, and
    // collapsing it into the shared predicate would lose the distinction.
    const noCopies = CONSUMERS.filter((f) => !f.includes("pos/page.tsx"));
    for (const f of noCopies) {
      expect(read(f)).not.toContain('paymentMethod === "CARD_TERMINAL"');
      expect(read(f)).not.toContain('paymentMethod === "PAYMENT_LINK"');
    }
  });
});
