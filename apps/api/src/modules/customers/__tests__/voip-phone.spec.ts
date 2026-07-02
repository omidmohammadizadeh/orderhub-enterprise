import { extractVoipPhone } from "../voip-phone.util";

// One webhook endpoint, many provider payload dialects.
describe("extractVoipPhone", () => {
  it("reads Twilio form fields", () => {
    expect(extractVoipPhone({ From: "+44 7788 180709", To: "+441913000000" })).toBe(
      "+447788180709",
    );
    expect(extractVoipPhone({ Caller: "+447788180709" })).toBe("+447788180709");
  });

  it("reads sipgate/generic lowercase fields", () => {
    expect(extractVoipPhone({ from: "447788180709" })).toBe("447788180709");
    expect(extractVoipPhone({ caller_id: "07788-180-709" })).toBe("07788180709");
    expect(extractVoipPhone({ phone: "07788180709" })).toBe("07788180709");
  });

  it("reads Telnyx nested payload", () => {
    expect(
      extractVoipPhone({ data: { payload: { from: { phone_number: "+447788180709" } } } }),
    ).toBe("+447788180709");
  });

  it("rejects junk", () => {
    expect(extractVoipPhone({})).toBeNull();
    expect(extractVoipPhone({ From: "anonymous" })).toBeNull();
    expect(extractVoipPhone(null)).toBeNull();
    expect(extractVoipPhone({ from: "123" })).toBeNull();
  });
});
