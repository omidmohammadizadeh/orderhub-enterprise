import { PROD_API_ORIGIN, publicApiBase } from "../public-api-url";
import { tapChargeWebhookUrl } from "../../modules/payments/tap.service";
import { whatsappWebhookUrl } from "../../modules/whatsapp/whatsapp-connection.service";
import { integrationWebhookUrl } from "../../modules/integrations/integrations.service";

const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

// Render production: API_URL is the bare host, API_PUBLIC_URL the service name.
const RENDER = env({ API_URL: "https://orderhub-api-0re6.onrender.com", API_PUBLIC_URL: "orderhub-api-0re6" });

describe("publicApiBase", () => {
  it("adds the /api global prefix to a bare API_URL, and never doubles it", () => {
    expect(publicApiBase(env({ API_URL: "https://x.com" }))).toBe("https://x.com/api");
    expect(publicApiBase(env({ API_URL: "https://x.com/" }))).toBe("https://x.com/api");
    expect(publicApiBase(env({ API_URL: "https://x.com/api/" }))).toBe("https://x.com/api");
  });

  it("skips a value that isn't a URL (production's API_PUBLIC_URL)", () => {
    expect(publicApiBase(env({ API_PUBLIC_URL: "orderhub-api-0re6", PUBLIC_API_URL: "https://y.com" }))).toBe(
      "https://y.com/api",
    );
  });

  it("falls back to production when nothing usable is set", () => {
    expect(publicApiBase(env({}))).toBe(`${PROD_API_ORIGIN}/api`);
    expect(publicApiBase(env({ API_PUBLIC_URL: "orderhub-api-0re6" }))).toBe(`${PROD_API_ORIGIN}/api`);
  });
});

describe("third-party callback URLs on Render's env", () => {
  const api = "https://orderhub-api-0re6.onrender.com/api/v1";

  it("Tap charge webhook", () => {
    expect(tapChargeWebhookUrl(RENDER)).toBe(`${api}/payments/tap/webhook`);
  });

  it("WhatsApp (Meta) webhook", () => {
    expect(whatsappWebhookUrl(RENDER)).toBe(`${api}/whatsapp/webhook`);
  });

  it("generic integration webhook matches WebhooksController's :platform/:locationId route", () => {
    expect(integrationWebhookUrl("loc1", "UBER_EATS", RENDER)).toBe(`${api}/webhooks/uber-eats/loc1`);
    expect(integrationWebhookUrl("loc1", "DELIVEROO", RENDER)).toBe(`${api}/webhooks/deliveroo/loc1`);
  });
});
