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

// A sender that reads a notification carrying the caller's number twice can
// join them and then cut the result at its own length limit. 07940053972
// reached a till as 079400539720794 — the trailing 0794 being the head of the
// same number is what identifies it, and what makes shortening a repair
// rather than a guess.
describe("extractVoipPhone — a number with a piece of itself on the end", () => {
  it("repairs the real failure: 07940053972 sent as 079400539720794", () => {
    expect(extractVoipPhone({ phone: "079400539720794" })).toBe("07940053972");
  });

  it("repairs the bOnline case too", () => {
    expect(extractVoipPhone({ phone: "074384673800743" })).toBe("07438467380");
  });

  it("repairs an international number that overran", () => {
    expect(extractVoipPhone({ from: "+4413884368444413" })).toBe("+441388436844");
  });

  it("leaves a clean UK mobile alone", () => {
    expect(extractVoipPhone({ phone: "07940053972" })).toBe("07940053972");
  });

  it("leaves a clean international number alone", () => {
    expect(extractVoipPhone({ from: "+441388436844" })).toBe("+441388436844");
  });

  it("does NOT shorten a long number whose tail is not its own head", () => {
    // 14 digits, tail bears no relation to the start — a real long
    // international number, not a doubling. Shortening it would invent one.
    expect(extractVoipPhone({ phone: "35318765432199" })).toBe("35318765432199");
  });

  it("does not treat two different numbers as a doubling", () => {
    // Equal-length halves: this is two numbers, and we cannot know which is
    // the caller. Left as-is for the length check to reject.
    expect(extractVoipPhone({ phone: "0794005397207940053972" })).toBeNull();
  });
});
