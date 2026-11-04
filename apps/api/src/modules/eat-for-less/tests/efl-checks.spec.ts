import { fsaIdFromUrl, normaliseCompanyNumber, pickEstablishment, ratingBelowMinimum } from "../efl-checks";
import { nextHiddenReason } from "../efl-hygiene.service";
import { decodeDocument } from "../efl-applications.service";

describe("fsaIdFromUrl", () => {
  it("reads both link shapes the ratings site uses", () => {
    expect(fsaIdFromUrl("https://ratings.food.gov.uk/business/1370113/pizza-pizza-westerhope")).toBe("1370113");
    expect(fsaIdFromUrl("https://ratings.food.gov.uk/business/en-GB/1370113/Pizza-Pizza")).toBe("1370113");
  });

  it("refuses anything else", () => {
    expect(fsaIdFromUrl("https://example.com/business/1370113")).toBeNull();
    expect(fsaIdFromUrl("")).toBeNull();
    expect(fsaIdFromUrl(null)).toBeNull();
  });
});

describe("ratingBelowMinimum", () => {
  it("compares numeric ratings", () => {
    expect(ratingBelowMinimum("1", 2)).toBe(true);
    expect(ratingBelowMinimum("2", 2)).toBe(false);
    expect(ratingBelowMinimum("5", 3)).toBe(false);
  });

  it("treats Scotland's Improvement Required as below, Pass as fine", () => {
    expect(ratingBelowMinimum("Improvement Required", 2)).toBe(true);
    expect(ratingBelowMinimum("Pass", 2)).toBe(false);
    expect(ratingBelowMinimum("Pass and Eat Safe", 5)).toBe(false);
  });

  it("never holds an unrated shop against itself", () => {
    expect(ratingBelowMinimum("AwaitingInspection", 2)).toBe(false);
    expect(ratingBelowMinimum("Exempt", 2)).toBe(false);
    expect(ratingBelowMinimum(null, 2)).toBe(false);
  });
});

describe("nextHiddenReason", () => {
  it("hides a shop that falls below, and brings it back when it recovers", () => {
    expect(nextHiddenReason(null, true)).toBe("HYGIENE");
    expect(nextHiddenReason("HYGIENE", false)).toBeNull();
  });

  it("never undoes a hide it didn't make", () => {
    expect(nextHiddenReason("OFFLINE", false)).toBe("OFFLINE");
    expect(nextHiddenReason("OFFLINE", true)).toBe("OFFLINE");
  });
});

describe("normaliseCompanyNumber", () => {
  it("pads numeric numbers to 8 and keeps lettered ones", () => {
    expect(normaliseCompanyNumber("123456")).toBe("00123456");
    expect(normaliseCompanyNumber(" sc 123456 ")).toBe("SC123456");
  });

  it("refuses junk", () => {
    expect(normaliseCompanyNumber("12-34")).toBeNull();
    expect(normaliseCompanyNumber("123456789")).toBeNull();
  });
});

describe("pickEstablishment", () => {
  const r = (id: string, name: string, postcode: string) => ({
    establishmentId: id,
    businessName: name,
    postcode,
    rating: "5",
    ratingDate: null,
  });

  it("takes the matching name at the shop's postcode", () => {
    const pick = pickEstablishment(
      [r("1", "Westerhope Fish Bar", "NE5 5HH"), r("2", "Pizza Pizza (Westerhope)", "NE5 5HH"), r("3", "Pizza Pizza", "NE1 1AA")],
      { name: "Pizza Pizza", postcode: "ne55hh" },
    );
    expect(pick?.establishmentId).toBe("2");
  });

  it("finds nothing at another postcode", () => {
    expect(pickEstablishment([r("3", "Pizza Pizza", "NE1 1AA")], { name: "Pizza Pizza", postcode: "NE5 5HH" })).toBeNull();
  });
});

describe("decodeDocument", () => {
  it("accepts a PDF and reports its type", () => {
    const doc = decodeDocument(`data:application/pdf;base64,${Buffer.from("%PDF-1.4").toString("base64")}`);
    expect(doc.ext).toBe("pdf");
    expect(doc.buffer.toString()).toBe("%PDF-1.4");
  });

  it("refuses other file types and oversized files", () => {
    expect(() => decodeDocument("data:text/html;base64,PGh0bWw+")).toThrow(/PDF, JPG or PNG/);
    const big = Buffer.alloc(3_600_000).toString("base64");
    expect(() => decodeDocument(`data:image/png;base64,${big}`)).toThrow(/3.5 MB/);
  });
});
