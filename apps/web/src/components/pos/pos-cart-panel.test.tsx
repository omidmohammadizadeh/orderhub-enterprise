// What an amendment charges for delivery.
//
// The panel re-derives the delivery fee from a zone lookup every time it
// mounts, and starts at zero. Nothing carried the fee an order ALREADY had,
// so any amendment whose lookup didn't come back — offline, a 429 the
// cooldown interceptor rejected locally, or a zone renamed since the order
// was taken — submitted £0.00 and took the delivery charge off a bill the
// customer had already been quoted. Nothing on screen said so either: the
// lookup's note was set in four places and rendered in none.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PosCartPanel } from "./pos-cart-panel";

const lookupMock = vi.fn();
vi.mock("@/lib/api/pos.client", () => ({
  deliveryZonesClient: {
    lookup: (...args: unknown[]) => lookupMock(...args),
    list: async () => [],
  },
  promoCodesClient: { list: async () => [] },
}));

vi.mock("@/hooks/use-currency", () => ({
  useCurrency: () => ({
    money: (n: number) => `£${Number(n).toFixed(2)}`,
    country: "GB",
    currency: "GBP",
  }),
}));

vi.mock("@/lib/pos/use-online-status", () => ({ useOnlineStatus: () => true }));

// The shared address field pulls in its own zone + lookup queries; none of
// that is what this file is about.
vi.mock("./delivery-address-field", () => ({
  DeliveryAddressField: () => null,
}));

const DRAFT = {
  customerName: "Omid",
  customerPhone: "+447700900123",
  fulfillmentType: "DELIVERY" as const,
  addressLine1: "1 Old Street",
  city: "London",
  postcode: "N1 6AH",
};

let lastPayload: any = null;

function renderPanel(existingDeliveryFee?: number) {
  lastPayload = null;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PosCartPanel
        locationId="loc-1"
        cart={[
          {
            id: "c1",
            menuItemId: "m1",
            displayName: "Margherita",
            unitPrice: 20,
            quantity: 1,
            modifiers: [],
            notes: "",
          },
        ]}
        onRemoveLine={() => {}}
        onChangeQty={() => {}}
        onClearCart={() => {}}
        onPlaceOrder={(p) => {
          lastPayload = p;
        }}
        submitting={false}
        submitButtonLabel="Save changes"
        existingDeliveryFee={existingDeliveryFee}
        initialDraft={DRAFT}
      />
    </QueryClientProvider>,
  );
}

/** The Delivery row in the totals, as an operator reads it.
 *
 *  Asserts INSIDE waitFor. A waitFor whose callback only reads returns on its
 *  first attempt, so it reports the fee as it was before the lookup resolved
 *  — which is the carried fee, and would have made every "keeps the fee"
 *  test below pass without the lookup running at all. */
async function expectDelivery(amount: string) {
  await waitFor(() => {
    const row = screen.getByText("Delivery").parentElement!;
    expect(row.textContent).toContain(amount);
  });
}

/** The lookup's own verdict. Waiting on this first is what proves the branch
 *  under test actually ran, rather than the assertion catching initial state. */
async function expectNote(pattern: RegExp) {
  await waitFor(() => expect(screen.getByText(pattern)).toBeInTheDocument());
}

beforeEach(() => {
  lookupMock.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

describe("an amended order's delivery fee", () => {
  it("keeps the order's fee when the lookup fails outright", async () => {
    lookupMock.mockRejectedValue(new Error("Network Error"));
    renderPanel(3.5);
    await vi.advanceTimersByTimeAsync(400);
    // The note only exists once the failure has been handled, so reaching it
    // proves the fee below survived the lookup rather than preceding it.
    await expectNote(/Couldn't check the delivery fee/i);
    await expectDelivery("£3.50");
  });

  it("says it couldn't check, rather than showing a silent £0.00", async () => {
    // A £0.00 with nothing beside it reads exactly like a shop that
    // delivers free.
    lookupMock.mockRejectedValue(new Error("Network Error"));
    renderPanel(3.5);
    await vi.advanceTimersByTimeAsync(400);
    await expectNote(/Couldn't check the delivery fee/i);
    expect(screen.getByText(/keeping the £3.50/i)).toBeInTheDocument();
  });

  it("keeps the order's fee when the zone no longer matches", async () => {
    // Renamed or deleted since the order was taken. The customer was quoted
    // the old fee; an amendment about a drink must not drop it.
    lookupMock.mockResolvedValue({ matched: false });
    renderPanel(3.5);
    await vi.advanceTimersByTimeAsync(400);
    await expectNote(/any more/i);
    await expectDelivery("£3.50");
  });

  it("takes the new fee when the lookup does price the address", async () => {
    // The whole point of re-checking: a changed address re-prices.
    lookupMock.mockResolvedValue({ matched: true, fee: 5, label: "M1" });
    renderPanel(3.5);
    await vi.advanceTimersByTimeAsync(400);
    await expectDelivery("£5.00");
  });

  it("still zeroes an unmatched zone on a NEW order", async () => {
    // Nothing has been quoted yet, so there is nothing to protect — and the
    // operator is told to set a fee or add a zone.
    lookupMock.mockResolvedValue({ matched: false });
    renderPanel(undefined);
    await vi.advanceTimersByTimeAsync(400);
    await expectNote(/Set a manual fee or add a zone/i);
    await expectDelivery("£0.00");
  });

  it("tells a new order's operator when the lookup couldn't run at all", async () => {
    lookupMock.mockRejectedValue(new Error("Network Error"));
    renderPanel(undefined);
    await vi.advanceTimersByTimeAsync(400);
    await expectNote(/Set one manually before saving/i);
  });
});
