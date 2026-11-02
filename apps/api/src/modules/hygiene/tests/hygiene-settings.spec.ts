import { hygieneFromResult, mergeHygiene, publicHygiene, readHygiene } from "../hygiene-settings";
import { LocationHygieneService } from "../location-hygiene.service";

// BJ's Plaice, Ortongate — the real record this was built against.
const BJS = {
  establishmentId: "247023",
  businessName: "BJ's Plaice",
  postcode: "PE2 5TD",
  rating: "4",
  ratingDate: "2025-08-05T00:00:00",
};

describe("mergeHygiene", () => {
  it("adds hygiene and keeps every other settings key", () => {
    const h = hygieneFromResult(BJS, null, new Date("2026-10-27T03:30:00Z"));
    const merged = mergeHygiene({ storefrontSplash: [{ id: "x" }], tableService: { enabled: true } }, h);
    expect(merged).toEqual({
      storefrontSplash: [{ id: "x" }],
      tableService: { enabled: true },
      hygiene: {
        fsaId: "247023",
        rating: "4",
        ratingDate: "2025-08-05T00:00:00",
        checkedAt: "2026-10-27T03:30:00.000Z",
        show: true,
      },
    });
  });

  it("copes with empty or junk settings", () => {
    const h = hygieneFromResult(BJS, null);
    expect(mergeHygiene(null, h)).toEqual({ hygiene: h });
    expect(mergeHygiene([], h)).toEqual({ hygiene: h });
  });
});

describe("hygieneFromResult", () => {
  it("keeps the show switch across a re-check", () => {
    const hidden = { ...hygieneFromResult(BJS, null), show: false };
    expect(hygieneFromResult({ ...BJS, rating: "5" }, hidden)).toMatchObject({ rating: "5", show: false });
  });
});

describe("publicHygiene", () => {
  it("serves rating, date and the FSA page", () => {
    const settings = mergeHygiene({}, hygieneFromResult(BJS, null));
    expect(publicHygiene(settings)).toEqual({
      rating: "4",
      ratingDate: "2025-08-05T00:00:00",
      url: "https://ratings.food.gov.uk/business/247023",
    });
  });

  it("is null when the shop hid it", () => {
    const settings = mergeHygiene({}, { ...hygieneFromResult(BJS, null), show: false });
    expect(publicHygiene(settings)).toBeNull();
  });

  it("treats a missing show as shown", () => {
    expect(publicHygiene({ hygiene: { fsaId: "247023", rating: "4" } })).toMatchObject({ rating: "4", ratingDate: null });
  });

  it("is null with no link or no rating", () => {
    expect(publicHygiene({})).toBeNull();
    expect(publicHygiene(null)).toBeNull();
    expect(publicHygiene({ hygiene: { fsaId: "247023", rating: "" } })).toBeNull();
    expect(readHygiene({ hygiene: { rating: "4" } })).toBeNull();
  });

  it("passes Scottish and not-yet-rated values through as text", () => {
    expect(publicHygiene({ hygiene: { fsaId: "1", rating: "Improvement Required" } })?.rating).toBe("Improvement Required");
    expect(publicHygiene({ hygiene: { fsaId: "1", rating: "AwaitingInspection" } })?.rating).toBe("AwaitingInspection");
  });
});

describe("LocationHygieneService.refreshAll", () => {
  const linked = { hygiene: { fsaId: "247023", rating: "3", ratingDate: "2023-01-01", checkedAt: "x", show: true }, other: 1 };

  function harness(fsaAnswer: unknown) {
    const update = jest.fn();
    const prisma: any = {
      location: {
        findMany: jest.fn().mockResolvedValue([
          { id: "loc1", settings: linked },
          { id: "loc2", settings: { other: 2 } },
        ]),
        findUnique: jest.fn().mockResolvedValue({ settings: linked }),
        update,
      },
    };
    const svc = new LocationHygieneService(prisma);
    (svc as any).fsa = { hygieneById: jest.fn().mockResolvedValue(fsaAnswer) };
    return { svc, update };
  }

  it("writes the fresh rating, keeping other settings", async () => {
    const { svc, update } = harness(BJS);
    expect(await svc.refreshAll()).toEqual({ checked: 1, updated: 1, failed: 0 });
    const written = update.mock.calls[0][0].data.settings;
    expect(written.other).toBe(1);
    expect(written.hygiene).toMatchObject({ fsaId: "247023", rating: "4", ratingDate: "2025-08-05T00:00:00", show: true });
  });

  it("changes nothing when the FSA call fails", async () => {
    const { svc, update } = harness(null);
    expect(await svc.refreshAll()).toEqual({ checked: 1, updated: 0, failed: 1 });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("LocationHygieneService.update", () => {
  const stored = { fsaId: "247023", rating: "4", ratingDate: "2025-08-05T00:00:00", checkedAt: "x", show: true };

  function harness(settings: unknown) {
    const update = jest.fn();
    const prisma: any = {
      location: {
        findFirst: jest.fn().mockResolvedValue({
          id: "loc1",
          name: "BJ's Plaice Orton",
          postcode: "PE2 5TD",
          settings,
          brand: { name: "BJ's Plaice" },
        }),
        update,
      },
    };
    const svc = new LocationHygieneService(prisma);
    const fsa = { hygieneById: jest.fn().mockResolvedValue(BJS), findHygiene: jest.fn().mockResolvedValue(BJS) };
    (svc as any).fsa = fsa;
    return { svc, update, fsa };
  }

  it("flips show without calling the FSA", async () => {
    const { svc, update, fsa } = harness({ hygiene: stored, other: 1 });
    expect(await svc.update("loc1", "t1", { show: false })).toMatchObject({ show: false, rating: "4" });
    expect(fsa.hygieneById).not.toHaveBeenCalled();
    expect(fsa.findHygiene).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].data.settings).toMatchObject({ other: 1, hygiene: { show: false } });
  });

  it("links from a ratings link", async () => {
    const { svc, fsa } = harness({});
    await svc.update("loc1", "t1", { url: "https://ratings.food.gov.uk/business/247023/bjs-plaice" });
    expect(fsa.hygieneById).toHaveBeenCalledWith("247023");
  });

  it("searches by brand name at the postcode when given nothing", async () => {
    const { svc, fsa } = harness({});
    expect(await svc.update("loc1", "t1", {})).toMatchObject({ fsaId: "247023", show: true });
    expect(fsa.findHygiene).toHaveBeenCalledWith({ name: "BJ's Plaice", postcode: "PE2 5TD" });
  });

  it("refuses a link that isn't an FSA one", async () => {
    const { svc, update } = harness({});
    await expect(svc.update("loc1", "t1", { url: "https://example.com/x" })).rejects.toThrow(/ratings\.food\.gov\.uk/);
    expect(update).not.toHaveBeenCalled();
  });
});
