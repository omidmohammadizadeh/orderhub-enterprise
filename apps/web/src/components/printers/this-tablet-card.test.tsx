// The per-tablet printer control.
//
// Two rules worth holding: it only appears when there is genuinely a choice to
// make (one counter printer means nothing to decide, and a control that can't
// change anything is just noise), and an unset tablet is warned about — that
// is the state where receipts print on every counter and the wrong cash
// drawer opens.
//
// This also exercises the React half of the test setup: if jsdom, the React
// plugin or the "@/" alias were misconfigured, this file fails and the pure
// store tests would still pass, hiding it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDeviceStore } from "@/stores/device.store";
import { ThisTabletCard } from "./this-tablet-card";

const listMock = vi.fn();
vi.mock("@/lib/api/printers.client", () => ({
  printersClient: { list: (...args: unknown[]) => listMock(...args) },
}));

const counter = (id: string, name: string) => ({
  id,
  name,
  kind: "FRONT_COUNTER",
  isActive: true,
});

function renderCard(locationId = "loc-1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ThisTabletCard locationId={locationId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useDeviceStore.setState({ cardMachineByLocation: {}, printerByLocation: {} });
  listMock.mockReset();
});

describe("ThisTabletCard", () => {
  it("stays out of the way when there's only one counter printer", async () => {
    listMock.mockResolvedValue([counter("p1", "Counter")]);
    renderCard();
    // Nothing to choose between, so nothing to show.
    await expect(screen.findByText(/this tablet/i)).rejects.toThrow();
  });

  it("warns an unset tablet that it may open the wrong drawer", async () => {
    listMock.mockResolvedValue([counter("p1", "Till 1"), counter("p2", "Till 2")]);
    renderCard();
    expect(await screen.findByText(/wrong cash drawer/i)).toBeInTheDocument();
  });

  it("remembers the chosen printer against this location", async () => {
    listMock.mockResolvedValue([counter("p1", "Till 1"), counter("p2", "Till 2")]);
    renderCard("loc-7");
    const select = await screen.findByLabelText(/receipt printer for this tablet/i);
    await userEvent.selectOptions(select, "p2");

    expect(useDeviceStore.getState().printerByLocation).toEqual({ "loc-7": "p2" });
    // The warning goes once a printer is claimed.
    expect(screen.queryByText(/wrong cash drawer/i)).not.toBeInTheDocument();
  });

  it("ignores printers that aren't front counters", async () => {
    listMock.mockResolvedValue([
      counter("p1", "Till 1"),
      { id: "p_kitchen", name: "Kitchen", kind: "KITCHEN", isActive: true },
    ]);
    renderCard();
    // One counter + a kitchen printer is still only one thing to choose.
    await expect(screen.findByText(/this tablet/i)).rejects.toThrow();
  });
});
