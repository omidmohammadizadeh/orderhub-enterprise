import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryFeeModal } from "./delivery-fee-modal";

const update = vi.hoisted(() => vi.fn());
const zones = [
  { id: "z1", postcodePrefix: "NE10", areaName: null, fee: "1.00", minOrderValue: "15.00", isActive: true },
  { id: "z2", postcodePrefix: "NE11", areaName: null, fee: "4.00", minOrderValue: null, isActive: true },
  { id: "z3", postcodePrefix: null, areaName: null, maxDistanceMiles: "3", fee: "2.00", minOrderValue: null, isActive: true },
];

vi.mock("@/lib/api/pos.client", () => ({
  deliveryZonesClient: { update, create: vi.fn(), remove: vi.fn() },
}));
vi.mock("@/lib/pos/offline-cache", () => ({
  listZonesCached: vi.fn(async () => zones),
}));
vi.mock("@/hooks/use-currency", () => ({
  useCurrency: () => ({ money: (n: number) => `£${Number(n).toFixed(2)}`, symbol: "£", country: "GB" }),
}));

const open = async (label: string) => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DeliveryFeeModal locationId="loc" onClose={() => {}} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByLabelText(label));
};
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("editing a delivery zone", () => {
  beforeEach(() => {
    update.mockReset();
    update.mockResolvedValue({});
  });

  it("opens with the current values and saves a new price", async () => {
    await open("Edit NE10");
    expect(screen.getByLabelText("Postcode")).toHaveValue("NE10");
    expect(screen.getByLabelText("Fee (£)")).toHaveValue(1);
    expect(screen.getByLabelText("Min order (£)")).toHaveValue(15);
    type("Fee (£)", "2.50");
    fireEvent.click(screen.getByLabelText("Save"));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("z1", { fee: 2.5, minOrderValue: 15, postcodePrefix: "NE10" }),
    );
    await waitFor(() => expect(screen.queryByLabelText("Save")).toBeNull());
  });

  it("clearing the minimum removes it", async () => {
    await open("Edit NE10");
    type("Min order (£)", "");
    fireEvent.click(screen.getByLabelText("Save"));
    await waitFor(() => expect(update.mock.calls[0]?.[1]).toMatchObject({ minOrderValue: null }));
  });

  it("refuses a blank fee rather than saving free delivery", async () => {
    await open("Edit NE10");
    type("Fee (£)", "");
    fireEvent.click(screen.getByLabelText("Save"));
    expect(await screen.findByText("Fee must be ≥ 0")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a postcode already on the list", async () => {
    await open("Edit NE10");
    type("Postcode", "ne11");
    fireEvent.click(screen.getByLabelText("Save"));
    expect(await screen.findByText(/already on the list/)).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it("cancel changes nothing", async () => {
    await open("Edit NE10");
    type("Fee (£)", "9");
    fireEvent.click(screen.getByLabelText("Cancel"));
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText("£1.00")).toBeInTheDocument();
  });

  it("a distance zone edits its price but has no name to change", async () => {
    await open("Edit zone");
    expect(screen.queryByLabelText("Postcode")).toBeNull();
    type("Fee (£)", "3");
    fireEvent.click(screen.getByLabelText("Save"));
    await waitFor(() => expect(update).toHaveBeenCalledWith("z3", { fee: 3, minOrderValue: null }));
  });
});
