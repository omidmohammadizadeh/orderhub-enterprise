import { WhatsAppAiService } from "../whatsapp-ai.service";

// The native Customise form and pick-many option groups.
//
// The form was radio-only, so a single "choose as many toppings as you like"
// group sent the whole item to the tap-by-tap chat wizard — the thing the form
// exists to replace. Each slot now carries a checkbox twin, and buildFlowData
// shows exactly one of the pair.
//
// The Flow's layout is fixed at publish time, so this contract is only half in
// the code: scripts/whatsapp-customise-flow.json has to declare the same slots.
// flow-json-contract.spec.ts checks the two agree.

const SLOTS = 12;

function makeService() {
  const svc = Object.create(WhatsAppAiService.prototype) as any;
  svc.flowGroupSlots = SLOTS;
  return svc;
}

const radio = (id: string, name: string, opts: string[], required = false) => ({
  id,
  name,
  required,
  min: required ? 1 : 0,
  max: 1,
  selectionType: "VARIANT",
  options: opts.map((o) => ({ id: o, name: o, price: 0 })),
});

const checkbox = (id: string, name: string, opts: string[], required = false) => ({
  id,
  name,
  required,
  min: required ? 1 : 0,
  max: null,
  selectionType: "ADDON",
  options: opts.map((o) => ({ id: o, name: o, price: 0.8 })),
});

const item = (groups: any[]) => ({
  id: "pizza",
  name: "Half And Half",
  description: "Pick your halves",
  price: 12,
  imageUrl: null,
  modifierGroups: groups,
});

describe("flowEligible", () => {
  it("accepts an item whose groups are all pick-many", () => {
    const svc = makeService();
    expect(
      svc.flowEligible(item([checkbox("g1", "Toppings", ["a", "b"])])),
    ).toBe(true);
  });

  it("accepts a mix of pick-one and pick-many", () => {
    const svc = makeService();
    const it_ = item([
      radio("s", "Size", ["10", "12"], true),
      checkbox("t", "Toppings", ["cheese", "corn"]),
    ]);
    expect(svc.flowEligible(it_)).toBe(true);
  });

  it("still refuses an item with more groups than slots", () => {
    const svc = makeService();
    const many = Array.from({ length: SLOTS + 1 }, (_, i) =>
      radio(`g${i}`, `G${i}`, ["x"]),
    );
    expect(svc.flowEligible(item(many))).toBe(false);
  });

  it("refuses an item with no groups (it needs no form)", () => {
    expect(makeService().flowEligible(item([]))).toBe(false);
  });
});

describe("buildFlowData", () => {
  it("renders a pick-many group as the checkbox twin, radio hidden", () => {
    const svc = makeService();
    const d = svc.buildFlowData(item([checkbox("t", "Toppings", ["cheese"])]));
    expect(d.c0_visible).toBe(true);
    expect(d.c0_label).toBe("Toppings");
    expect(d.g0_visible).toBe(false);
  });

  it("renders a pick-one group as the radio, checkbox hidden", () => {
    const svc = makeService();
    const d = svc.buildFlowData(item([radio("s", "Size", ["10"], true)]));
    expect(d.g0_visible).toBe(true);
    expect(d.c0_visible).toBe(false);
  });

  it("keeps each group in its own slot when the kinds are mixed", () => {
    const svc = makeService();
    const d = svc.buildFlowData(
      item([
        radio("s", "Size", ["10"], true),
        checkbox("t", "Toppings", ["cheese"]),
      ]),
    );
    expect([d.g0_visible, d.c0_visible]).toEqual([true, false]);
    expect([d.g1_visible, d.c1_visible]).toEqual([false, true]);
  });

  it("offers a No-X row on an optional radio but never on a checkbox", () => {
    const svc = makeService();
    const d = svc.buildFlowData(
      item([
        radio("s", "Sauce", ["bbq"]),
        checkbox("t", "Toppings", ["cheese"]),
      ]),
    );
    expect((d.g0_options as any[])[0].id).toBe("none");
    expect((d.c1_options as any[]).map((o: any) => o.id)).toEqual(["cheese"]);
  });

  it("fills every slot's keys, including the hidden twins", () => {
    const svc = makeService();
    const d = svc.buildFlowData(item([checkbox("t", "Toppings", ["cheese"])]));
    // A dangling ${data.x} reference fails the whole send, so no key may be absent.
    for (let i = 0; i < SLOTS; i++) {
      for (const p of ["g", "c"]) {
        for (const suffix of ["visible", "label", "required", "options"]) {
          expect(d).toHaveProperty(`${p}${i}_${suffix}`);
        }
      }
    }
  });
});

describe("parseFlowOptionIds", () => {
  const parse = (payload: Record<string, unknown>) =>
    makeService().parseFlowOptionIds(payload);

  it("takes the single id from a radio slot", () => {
    expect(parse({ g0: "size_12" })).toEqual(["size_12"]);
  });

  it("takes every id from a checkbox array", () => {
    expect(parse({ c0: ["cheese", "corn", "ham"] })).toEqual([
      "cheese",
      "corn",
      "ham",
    ]);
  });

  it("reads a checkbox array that arrived serialised as a string", () => {
    expect(parse({ c0: '["cheese","corn"]' })).toEqual(["cheese", "corn"]);
  });

  it("ignores an untouched checkbox however it comes back", () => {
    expect(parse({ c0: "", c1: null, c2: [], c3: "[]" })).toEqual([]);
  });

  it("drops the No-X row and empty-slot placeholders", () => {
    expect(parse({ g0: "none", g1: "_", g2: "bbq" })).toEqual(["bbq"]);
  });

  it("combines radio and checkbox answers across slots", () => {
    expect(parse({ g0: "size_12", c1: ["cheese", "corn"], g2: "thin" })).toEqual(
      ["size_12", "cheese", "corn", "thin"],
    );
  });

  it("de-duplicates an id that appears in two groups", () => {
    expect(parse({ c0: ["cheese"], c1: ["cheese", "corn"] })).toEqual([
      "cheese",
      "corn",
    ]);
  });

  it("survives malformed JSON rather than losing the order", () => {
    expect(parse({ c0: "[broken", g1: "bbq" })).toEqual(["bbq"]);
  });
});
