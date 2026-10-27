import { appClientFromUserAgent } from "../app-client";

// The restaurant apps' WebView appends "OrderHubApp/<brand>" to the phone's
// own agent; staff see "App · Android" / "App · iPhone" on the order.
describe("appClientFromUserAgent", () => {
  it("reads an Android app order", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 15; Pixel 7 Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile Safari/537.36 OrderHubApp/kingstonpizza";
    expect(appClientFromUserAgent(ua)).toEqual({ app: "kingstonpizza", platform: "android" });
  });

  it("reads an iPhone app order", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 OrderHubApp/pizzaunopelton";
    expect(appClientFromUserAgent(ua)).toEqual({ app: "pizzaunopelton", platform: "ios" });
  });

  it("leaves website orders alone", () => {
    expect(appClientFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Safari/604.1")).toBeNull();
    expect(appClientFromUserAgent(undefined)).toBeNull();
  });
});
