import { parseCsv, parseDuration, parsePrice, readPriceList } from "../salon-import";

describe("salon price-list import", () => {
  it("reads quoted fields, doubled quotes and Windows line endings", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });

  it("works out the delimiter (Excel in Europe exports semicolons)", () => {
    expect(parseCsv("Name;Price\nFade;22")).toEqual([
      ["Name", "Price"],
      ["Fade", "22"],
    ]);
  });

  it("understands the ways people write a length", () => {
    expect(parseDuration("45")).toBe(45);
    expect(parseDuration("45 min")).toBe(45);
    expect(parseDuration("1h 15m")).toBe(75);
    expect(parseDuration("1 hr 30 mins")).toBe(90);
    expect(parseDuration("1:15")).toBe(75);
    expect(parseDuration("2 hours")).toBe(120);
    expect(parseDuration("")).toBeNull();
  });

  it("understands the ways people write a price", () => {
    expect(parsePrice("£22.00")).toEqual({ price: 22, from: false });
    expect(parsePrice("from £45")).toEqual({ price: 45, from: true });
    expect(parsePrice("£40 - £60")).toEqual({ price: 40, from: true });
    expect(parsePrice("AED 85")).toEqual({ price: 85, from: false });
    expect(parsePrice("22,50")).toEqual({ price: 22.5, from: false });
    expect(parsePrice("free?")).toBeNull();
  });

  it("imports a Fresha-style export", () => {
    const csv = [
      "Service name,Category,Duration,Price type,Retail price,Description",
      'Skin fade,Haircuts,30min,Fixed,£22.00,"Clipper fade, finished with scissors"',
      "Full head colour,Colour,2h,From,£65.00,",
      "Beard trim,Beard,20min,Fixed,£12.00,",
    ].join("\n");
    const r = readPriceList(csv);
    expect(r.columns).toMatchObject({ name: "Service name", category: "Category", duration: "Duration", price: "Retail price" });
    expect(r.services).toEqual([
      { name: "Skin fade", category: "Haircuts", price: 22, priceFrom: false, durationMins: 30, description: "Clipper fade, finished with scissors" },
      { name: "Full head colour", category: "Colour", price: 65, priceFrom: true, durationMins: 120, description: null },
      { name: "Beard trim", category: "Beard", price: 12, priceFrom: false, durationMins: 20, description: null },
    ]);
  });

  it("imports a bare spreadsheet and says what it skipped", () => {
    const csv = ["Service,Price,Mins", "Haircut,18,30", ",10,10", "Haircut,20,30", "Mystery,,15", "Kids cut,14,"].join("\n");
    const r = readPriceList(csv);
    expect(r.services.map((s) => [s.name, s.price, s.durationMins])).toEqual([
      ["Haircut", 18, 30],
      ["Kids cut", 14, 30],
    ]);
    expect(r.skipped.map((s) => s.row)).toEqual([3, 4, 5]);
  });

  it("refuses a file with no name column", () => {
    expect(readPriceList("Foo,Bar\n1,2").skipped[0]!.reason).toMatch(/name column/);
  });
});

describe("salon client-list import", () => {
  const { readClientList } = jest.requireActual("../salon-import");

  it("reads separate first/last names, keeps consent only when given", () => {
    const csv = [
      "First Name,Last Name,Mobile Number,Email,Accepts Marketing",
      "Liam,Carter,07700 900101,LIAM@Example.com,Yes",
      "Noah,Patel,+44 7700 900102,,No",
      "Ghost,,,,",
      "Liam,Again,07700 900101,,",
    ].join("\n");
    const r = readClientList(csv);
    expect(r.clients).toEqual([
      { firstName: "Liam", lastName: "Carter", phone: "07700900101", email: "liam@example.com", marketingConsent: true },
      { firstName: "Noah", lastName: "Patel", phone: "+447700900102", email: null, marketingConsent: false },
    ]);
    expect(r.skipped.map((s: any) => s.reason)).toEqual(["Ghost has no phone or email", "Duplicate"]);
  });

  it("splits a single name column", () => {
    const r = readClientList("Client,Phone\nMaria de la Cruz,07700900103");
    expect(r.clients[0]).toMatchObject({ firstName: "Maria", lastName: "de la Cruz" });
  });
});
