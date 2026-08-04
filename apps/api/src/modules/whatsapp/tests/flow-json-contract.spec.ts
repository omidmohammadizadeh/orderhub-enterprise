import { readFileSync } from "fs";
import { join } from "path";

// The published Flow's layout is frozen at publish time, in Meta's console,
// out of this repo's reach. So the JSON we hand operators to paste and the
// data this service sends have to be checked against each other here — a
// mismatch doesn't fail a build, it fails a customer's order at the till.
//
// If the code sends a key the Flow doesn't declare, the reference dangles and
// the send fails outright. If the Flow declares a slot the code never fills,
// that slot renders empty. Both are silent until someone tries to order.

const flow = JSON.parse(
  readFileSync(
    join(__dirname, "../../../../../../scripts/whatsapp-customise-flow.json"),
    "utf8",
  ),
);

const screen = flow.screens[0];
const dataKeys = Object.keys(screen.data);

function componentsOfType(type: string): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      if (n.type === type) out.push(n);
      Object.values(n).forEach(walk);
    }
  };
  walk(screen.layout);
  return out;
}

function footerPayload(): Record<string, string> {
  const find = (n: any): any => {
    if (Array.isArray(n)) {
      for (const x of n) {
        const r = find(x);
        if (r) return r;
      }
    } else if (n && typeof n === "object") {
      if (n.payload) return n.payload;
      for (const v of Object.values(n)) {
        const r = find(v);
        if (r) return r;
      }
    }
    return null;
  };
  return find(screen.layout);
}

const RADIOS = componentsOfType("RadioButtonsGroup").length;
const CHECKBOXES = componentsOfType("CheckboxGroup").length;

describe("Customise Flow JSON", () => {
  it("is a single terminal screen on a supported version", () => {
    // Meta rejected "5.0" and "3.1"; 7.0 is what publishes.
    expect(flow.version).toBe("7.0");
    expect(flow.screens).toHaveLength(1);
    expect(screen.id).toBe("CUSTOMISE"); // hardcoded in the sender
    expect(screen.terminal).toBe(true);
  });

  it("pairs every radio slot with a checkbox slot", () => {
    expect(CHECKBOXES).toBe(RADIOS);
    expect(RADIOS).toBeGreaterThanOrEqual(12);
  });

  it("declares data keys for both twins of every slot", () => {
    for (let i = 0; i < RADIOS; i++) {
      for (const p of ["g", "c"]) {
        for (const suffix of ["visible", "label", "required", "options"]) {
          expect(dataKeys).toContain(`${p}${i}_${suffix}`);
        }
      }
    }
  });

  it("gives every data key an __example__", () => {
    // Meta rejects the Flow outright without them.
    const missing = dataKeys.filter((k) => !("__example__" in screen.data[k]));
    expect(missing).toEqual([]);
  });

  it("returns both twins of every slot in the completion payload", () => {
    const payload = footerPayload();
    expect(Object.keys(payload)).toContain("item_id");
    expect(Object.keys(payload)).toContain("notes");
    for (let i = 0; i < RADIOS; i++) {
      expect(payload[`g${i}`]).toBe(`\${form.g${i}}`);
      expect(payload[`c${i}`]).toBe(`\${form.c${i}}`);
    }
  });

  it("binds each component to its own slot's data", () => {
    componentsOfType("RadioButtonsGroup").forEach((c, i) => {
      expect(c.name).toBe(`g${i}`);
      expect(c["data-source"]).toBe(`\${data.g${i}_options}`);
      expect(c.visible).toBe(`\${data.g${i}_visible}`);
    });
    componentsOfType("CheckboxGroup").forEach((c, i) => {
      expect(c.name).toBe(`c${i}`);
      expect(c["data-source"]).toBe(`\${data.c${i}_options}`);
      expect(c.visible).toBe(`\${data.c${i}_visible}`);
    });
  });

  it("references no data key it hasn't declared", () => {
    const referenced = new Set<string>();
    for (const m of JSON.stringify(screen.layout).matchAll(
      /\$\{data\.([a-z0-9_]+)\}/gi,
    )) {
      referenced.add(m[1]!);
    }
    const undeclared = [...referenced].filter((k) => !dataKeys.includes(k));
    expect(undeclared).toEqual([]);
  });
});
