import {
  defaultSmsFrom,
  isSmsConfigured,
  parseInboundSms,
  sendSmsViaProvider,
  SmsProviderError,
  smsProvider,
} from "../sms-provider";

// The request/response shapes here are taken from each vendor's own API
// reference, not guessed — an SMS that "sent" but returned a shape we
// misread would bill a restaurant for a message nobody received.

const ENV = { ...process.env };

describe("SMS provider layer", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env = { ...ENV };
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });
  afterAll(() => {
    process.env = ENV;
  });

  const okJson = (body: unknown) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  });
  const errJson = (status: number, body: unknown) => ({
    ok: false,
    status,
    text: async () => JSON.stringify(body),
  });

  describe("provider selection", () => {
    it("defaults to Twilio and ignores an unknown provider name", () => {
      delete process.env.SMS_PROVIDER;
      expect(smsProvider()).toBe("TWILIO");
      process.env.SMS_PROVIDER = "SIGNALWIRE";
      expect(smsProvider()).toBe("TWILIO");
    });

    it("selects Telnyx case-insensitively", () => {
      process.env.SMS_PROVIDER = "telnyx";
      expect(smsProvider()).toBe("TELNYX");
    });

    it("reports Telnyx configured only with a key AND a sender", () => {
      process.env.SMS_PROVIDER = "TELNYX";
      process.env.TELNYX_API_KEY = "KEY";
      delete process.env.TELNYX_FROM;
      expect(isSmsConfigured()).toBe(false);
      process.env.TELNYX_FROM = "+447700900000";
      expect(isSmsConfigured()).toBe(true);
      expect(defaultSmsFrom()).toBe("+447700900000");
    });

    it("does not treat Twilio credentials as Telnyx being ready", () => {
      process.env.SMS_PROVIDER = "TELNYX";
      process.env.TWILIO_ACCOUNT_SID = "AC1";
      process.env.TWILIO_AUTH_TOKEN = "tok";
      process.env.TWILIO_FROM = "+447700900000";
      delete process.env.TELNYX_API_KEY;
      delete process.env.TELNYX_FROM;
      expect(isSmsConfigured()).toBe(false);
    });
  });

  describe("Telnyx send", () => {
    beforeEach(() => {
      process.env.SMS_PROVIDER = "TELNYX";
      process.env.TELNYX_API_KEY = "KEY123";
      process.env.TELNYX_FROM = "+447700900000";
    });

    it("posts to /v2/messages with Bearer auth and returns id + parts", async () => {
      fetchMock.mockResolvedValue(
        okJson({
          data: {
            id: "b0c7e8cb-6227-4c74-9f32-c7f80c30934b",
            parts: 2,
            cost: { amount: 0.0051, currency: "USD" },
          },
        }),
      );

      const result = await sendSmsViaProvider({
        to: "+447700900123",
        from: "PIZZAUNO",
        body: "Your order is ready",
      });

      expect(result).toEqual({
        id: "b0c7e8cb-6227-4c74-9f32-c7f80c30934b",
        segments: 2,
        cost: { amount: 0.0051, currency: "USD" },
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.telnyx.com/v2/messages");
      expect(init.headers.Authorization).toBe("Bearer KEY123");
      expect(JSON.parse(init.body)).toEqual({
        from: "PIZZAUNO",
        to: "+447700900123",
        text: "Your order is ready",
      });
    });

    it("includes messaging_profile_id when set — Telnyx REQUIRES it for a sender name", async () => {
      process.env.TELNYX_MESSAGING_PROFILE_ID = "profile-1";
      fetchMock.mockResolvedValue(okJson({ data: { id: "m1", parts: 1 } }));

      await sendSmsViaProvider({
        to: "+447700900123",
        from: "PIZZAUNO",
        body: "hi",
      });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
        messaging_profile_id: "profile-1",
      });
    });

    it("surfaces Telnyx's own error sentence, not a bare status code", async () => {
      fetchMock.mockResolvedValue(
        errJson(403, {
          errors: [
            {
              code: "40300",
              title: "Forbidden",
              detail:
                "The from number +447700900000 is not assigned to a messaging profile.",
            },
          ],
        }),
      );

      await expect(
        sendSmsViaProvider({ to: "+447700900123", from: "+447700900000", body: "hi" }),
      ).rejects.toThrow(
        "The from number +447700900000 is not assigned to a messaging profile.",
      );
    });

    it("falls back to the status line when the error body isn't JSON", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => "<html>bad gateway</html>",
      });
      await expect(
        sendSmsViaProvider({ to: "+447700900123", from: "X", body: "hi" }),
      ).rejects.toBeInstanceOf(SmsProviderError);
    });

    it("bills at least one segment when parts is missing", async () => {
      fetchMock.mockResolvedValue(okJson({ data: { id: "m2" } }));
      const r = await sendSmsViaProvider({
        to: "+447700900123",
        from: "X",
        body: "hi",
      });
      expect(r.segments).toBe(1);
    });
  });

  describe("Twilio send still works unchanged", () => {
    it("posts form-encoded and reads num_segments", async () => {
      process.env.SMS_PROVIDER = "TWILIO";
      process.env.TWILIO_ACCOUNT_SID = "AC1";
      process.env.TWILIO_AUTH_TOKEN = "tok";
      process.env.TWILIO_FROM = "+447700900000";
      fetchMock.mockResolvedValue(okJson({ sid: "SM1", num_segments: "3" }));

      const r = await sendSmsViaProvider({
        to: "+447700900123",
        from: "+447700900000",
        body: "hi",
      });

      expect(r).toEqual({ id: "SM1", segments: 3, cost: null });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain("api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
      expect(init.headers.Authorization).toMatch(/^Basic /);
    });
  });

  describe("inbound webhook parsing", () => {
    it("reads Twilio's form fields", () => {
      expect(parseInboundSms({ From: "+447700900123", Body: "STOP" })).toEqual({
        from: "+447700900123",
        text: "STOP",
      });
    });

    it("reads Telnyx's nested JSON", () => {
      expect(
        parseInboundSms({
          data: {
            event_type: "message.received",
            payload: {
              direction: "inbound",
              from: { phone_number: "+447700900123" },
              text: "STOP",
            },
          },
        }),
      ).toEqual({ from: "+447700900123", text: "STOP" });
    });

    it("ignores Telnyx delivery receipts on the same URL", () => {
      // message.sent/message.finalized arrive here too. Treating one as an
      // inbound message would read the RECIPIENT as a sender and, if the body
      // happened to say STOP, unsubscribe the wrong person.
      expect(
        parseInboundSms({
          data: {
            event_type: "message.finalized",
            payload: {
              direction: "outbound",
              from: { phone_number: "+447700900000" },
              text: "STOP by the shop later!",
            },
          },
        }),
      ).toEqual({ from: "", text: "" });
    });

    it("survives an empty or malformed body", () => {
      expect(parseInboundSms(undefined)).toEqual({ from: "", text: "" });
      expect(parseInboundSms({})).toEqual({ from: "", text: "" });
    });
  });
});
