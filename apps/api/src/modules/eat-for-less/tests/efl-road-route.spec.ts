import { RoadRoutes, decodePolyline, placeOnRoad, roadLeft } from "../efl-road-route";

describe("road route maths", () => {
  it("decodes Google's polyline format", () => {
    // Google's own documented example.
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ]);
  });

  // A straight 1 km street heading east, in Washington (Tyne and Wear).
  const street = [
    { lat: 54.9, lng: -1.52 },
    { lat: 54.9, lng: -1.5045 },
  ];

  it("places a driver along the road and says how far off it they are", () => {
    const half = placeOnRoad(street, { lat: 54.9, lng: -1.51225 });
    expect(half.total).toBeGreaterThan(980);
    expect(half.total).toBeLessThan(1020);
    expect(half.along / half.total).toBeCloseTo(0.5, 1);
    expect(half.off).toBeLessThan(1);
    // ~200 m north of the street.
    expect(placeOnRoad(street, { lat: 54.9018, lng: -1.51225 }).off).toBeGreaterThan(150);
  });

  it("works out what's left pro rata", () => {
    const left = roadLeft({ points: street, distanceMeters: 1000, durationSeconds: 240 }, { lat: 54.9, lng: -1.51225 });
    expect(left.metersLeft).toBeGreaterThan(450);
    expect(left.metersLeft).toBeLessThan(550);
    expect(left.secondsLeft).toBeGreaterThan(105);
    expect(left.secondsLeft).toBeLessThan(135);
  });
});

describe("RoadRoutes", () => {
  const shop = { lat: 54.9, lng: -1.52 };
  const door = { lat: 54.9, lng: -1.5045 };
  const reply = {
    ok: true,
    json: async () => ({ routes: [{ distanceMeters: 1000, duration: "240s", polyline: { encodedPolyline: "_p~iF~ps|U_ulLnnqC" } }] }),
  };

  function make(now = { t: 0 }) {
    const fetchImpl = jest.fn().mockResolvedValue(reply);
    return { roads: new RoadRoutes("key", fetchImpl as any, () => now.t), fetchImpl, now };
  }

  it("draws nothing without a key", async () => {
    const fetchImpl = jest.fn();
    await expect(new RoadRoutes(undefined, fetchImpl as any).forOrder("o1", shop, door)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks Google once per order, then reuses the road", async () => {
    const { roads, fetchImpl } = make();
    const first = await roads.forOrder("o1", shop, door);
    expect(first).toMatchObject({ distanceMeters: 1000, durationSeconds: 240 });
    await roads.forOrder("o1", shop, door);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers["X-Goog-Api-Key"]).toBe("key");
    expect(JSON.parse(init.body).travelMode).toBe("DRIVE");
  });

  it("re-asks from the driver only once they leave the road, at most once a minute", async () => {
    const { roads, fetchImpl, now } = make();
    const road = (await roads.forOrder("o1", shop, door))!;
    const onIt = road.points[0]!;
    const farOff = { lat: onIt.lat + 0.01, lng: onIt.lng };

    await roads.forOrder("o1", shop, door, onIt);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now.t = 30_000;
    await roads.forOrder("o1", shop, door, farOff);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now.t = 61_000;
    await roads.forOrder("o1", shop, door, farOff);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(body.origin.location.latLng).toEqual({ latitude: farOff.lat, longitude: farOff.lng });
  });

  it("keeps the old road when Google fails", async () => {
    const { roads, fetchImpl, now } = make();
    const road = await roads.forOrder("o1", shop, door);
    fetchImpl.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" });
    now.t = 120_000;
    await expect(roads.forOrder("o1", shop, door, { lat: 55.5, lng: -1.5 })).resolves.toBe(road);
  });
});
