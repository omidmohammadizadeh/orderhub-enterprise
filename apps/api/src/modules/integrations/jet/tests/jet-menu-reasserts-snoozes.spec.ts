import { JetMenuPublishService } from "../jet-menu-publish.service";

// A menu push puts every item back in stock on Just Eat.
//
// Nicole (JET), 21 Sep 2026: "The menu push will set items back into stock
// again and will override the stock status." So an item 86'd in Order Hub
// came back on Just Eat every time a menu was published — and "Push hours"
// now re-publishes the menu, which made it happen on every hours change.
//
// Once JET confirms the menu ingested, every item still snoozed for Just Eat
// at that location is sent UNAVAILABLE again. Not before: the ingest is
// asynchronous, and an availability update sent ahead of it is overwritten.

const FUTURE = new Date(Date.now() + 3 * 3600_000);
const PAST = new Date(Date.now() - 3600_000);

function make(opts: {
  snoozes?: Array<{ itemId: string; locationId: string | null; expiresAt: Date | null; channel?: string }>;
  menuItemIds?: string[];
  withAvailability?: boolean;
} = {}) {
  const pushItemAvailability = jest.fn().mockResolvedValue(undefined);
  const prisma = {
    brandPlatformConnection: {
      findFirst: jest.fn(async () => ({
        id: "conn-1",
        tenantId: "t1",
        brandId: "brand-1",
        locationId: "loc-1",
        metadata: { jetMenuPublish: { menuId: "menu-1" } },
      })),
      update: jest.fn().mockResolvedValue({}),
    },
    menuCategory: {
      findMany: jest.fn(async () => [
        { items: (opts.menuItemIds ?? ["item-a", "item-b"]).map((itemId) => ({ itemId })) },
      ]),
    },
    menuItemChannelAvailability: {
      findMany: jest.fn(async () =>
        (opts.snoozes ?? []).map((s) => ({ channel: "JUST_EAT", ...s })),
      ),
    },
  } as any;
  const activity = { record: jest.fn() } as any;
  const service = new (JetMenuPublishService as any)(
    prisma,
    { request: jest.fn() },
    { get: () => "https://api.example.com" },
    { forBrandChannel: jest.fn(async () => null) },
    activity,
    opts.withAvailability === false ? undefined : { pushItemAvailability },
  ) as JetMenuPublishService;
  return { service, pushItemAvailability, activity };
}

const ok = { restaurant: "440823", ingestion_succeeded: true };

describe("After a successful menu ingest, snoozed items go back out of stock", () => {
  it("re-sends UNAVAILABLE for an item still snoozed at this location", async () => {
    const { service, pushItemAvailability } = make({
      snoozes: [{ itemId: "item-a", locationId: "loc-1", expiresAt: null }],
    });
    await service.handleMenuCallback(ok);
    expect(pushItemAvailability).toHaveBeenCalledWith({
      tenantId: "t1",
      itemId: "item-a",
      available: false,
      until: null,
      locationId: "loc-1",
    });
  });

  it("keeps a timed snooze's expiry, so Just Eat restores it on time", async () => {
    const { service, pushItemAvailability } = make({
      snoozes: [{ itemId: "item-b", locationId: null, expiresAt: FUTURE }],
    });
    await service.handleMenuCallback(ok);
    expect(pushItemAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "item-b", until: FUTURE }),
    );
  });

  it("skips expired snoozes and items that are not on the published menu", async () => {
    const { service, pushItemAvailability } = make({
      snoozes: [
        { itemId: "item-a", locationId: "loc-1", expiresAt: PAST },
        { itemId: "not-on-menu", locationId: "loc-1", expiresAt: null },
      ],
    });
    await service.handleMenuCallback(ok);
    expect(pushItemAvailability).not.toHaveBeenCalled();
  });

  it("sends each item once even when it is snoozed globally and locally", async () => {
    const { service, pushItemAvailability } = make({
      snoozes: [
        { itemId: "item-a", locationId: null, expiresAt: FUTURE },
        { itemId: "item-a", locationId: "loc-1", expiresAt: null, channel: "ALL" },
      ],
    });
    await service.handleMenuCallback(ok);
    expect(pushItemAvailability).toHaveBeenCalledTimes(1);
    // Indefinite wins over timed: the item must not come back early.
    expect(pushItemAvailability.mock.calls[0][0].until).toBeNull();
  });

  it("does nothing when JET rejected the menu", async () => {
    const { service, pushItemAvailability } = make({
      snoozes: [{ itemId: "item-a", locationId: "loc-1", expiresAt: null }],
    });
    await service.handleMenuCallback({ restaurant: "440823", ingestion_succeeded: false });
    expect(pushItemAvailability).not.toHaveBeenCalled();
  });

  it("never fails the callback when a re-send fails", async () => {
    const { service, pushItemAvailability } = make({
      snoozes: [{ itemId: "item-a", locationId: "loc-1", expiresAt: null }],
    });
    pushItemAvailability.mockRejectedValueOnce(new Error("boom"));
    await expect(service.handleMenuCallback(ok)).resolves.toMatchObject({ handled: true });
  });
});
