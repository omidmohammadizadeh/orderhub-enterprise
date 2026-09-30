import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { feedRefetchInterval, ERROR_RETRY_MS } from "./use-live-orders-feed";
import {
  describeFeedError,
  OrdersFeedBanner,
  OrdersFeedError,
} from "../components/orders/feed-status";

describe("feedRefetchInterval", () => {
  it("does not poll while the socket is healthy", () => {
    expect(feedRefetchInterval({ errored: false, connected: true })).toBe(
      false,
    );
  });

  it("falls back to a slow poll when the socket is down", () => {
    expect(feedRefetchInterval({ errored: false, connected: false })).toBe(
      60_000,
    );
  });

  // The regression this whole change exists for: the board is socket-first,
  // so a connected-but-broken feed had NOTHING scheduled to fetch again and
  // sat on "Failed to load orders" until a human reloaded the tab.
  it("retries a broken feed even with the socket connected", () => {
    expect(feedRefetchInterval({ errored: true, connected: true })).toBe(
      ERROR_RETRY_MS,
    );
  });

  it("retries a broken feed faster than the disconnected fallback", () => {
    const broken = feedRefetchInterval({ errored: true, connected: false });
    expect(broken).toBe(ERROR_RETRY_MS);
    expect(broken).toBeLessThan(60_000);
  });
});

describe("describeFeedError", () => {
  it("names a rate-limit, whether it came from the server or our cooldown", () => {
    expect(describeFeedError({ response: { status: 429 } })).toMatch(
      /too many requests/,
    );
    expect(describeFeedError({ code: "ERR_RATE_LIMIT_COOLDOWN" })).toMatch(
      /too many requests/,
    );
  });

  it("distinguishes an unreachable server from a server error", () => {
    expect(describeFeedError(new Error("Network Error"))).toMatch(
      /can't reach the server/,
    );
    expect(describeFeedError({ response: { status: 502 } })).toMatch(
      /server error \(502\)/,
    );
  });

  it("calls out a rejected session", () => {
    expect(describeFeedError({ response: { status: 401 } })).toMatch(
      /session not accepted/,
    );
  });
});

describe("feed status views", () => {
  it("announces a total failure and lets the operator retry by hand", async () => {
    const onRetry = vi.fn();
    render(
      <OrdersFeedError error={{ response: { status: 502 } }} onRetry={onRetry} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Failed to load orders — server error \(502\)/,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/Retrying automatically/);
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("warns politely — not as an alert — when tickets are still on screen", () => {
    render(<OrdersFeedBanner error={new Error("Network Error")} />);
    const strip = screen.getByRole("status");
    expect(strip).toHaveTextContent(/Not updating — can't reach the server/);
    expect(strip).toHaveTextContent(/Showing the last orders we received/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("disables the retry button while a retry is already in flight", () => {
    render(<OrdersFeedBanner error={new Error("x")} isRetrying onRetry={vi.fn()} />);
    expect(screen.getByRole("button", { name: /retry now/i })).toBeDisabled();
  });
});
