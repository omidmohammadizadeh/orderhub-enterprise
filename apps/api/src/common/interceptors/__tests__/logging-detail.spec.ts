import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describeError } from "../logging.interceptor";

// A validation failure used to log as "Bad Request Exception" and nothing
// else, which is the same line whatever field broke. These pin that the field
// and its constraint reach the log, and that request bodies never do.

describe("describeError", () => {
  it("names the failing fields from a ValidationPipe rejection", () => {
    const err = new BadRequestException([
      "imageUrl must be a string",
      "basePrice must not be less than 0",
    ]);

    const out = describeError(err);

    expect(out).toContain("imageUrl must be a string");
    expect(out).toContain("basePrice must not be less than 0");
  });

  it("caps a long list so one bad payload can't flood the log", () => {
    const err = new BadRequestException(
      Array.from({ length: 9 }, (_, i) => `field${i} is wrong`),
    );

    const out = describeError(err);

    expect(out).toContain("field0 is wrong");
    expect(out).toContain("(+4 more)");
    expect(out).not.toContain("field8 is wrong");
  });

  it("keeps a plain message as it is", () => {
    expect(describeError(new NotFoundException("Order not found"))).toContain(
      "Order not found",
    );
  });

  it("doesn't repeat itself when the detail matches the message", () => {
    const out = describeError(new NotFoundException("Order not found"));
    expect(out.match(/Order not found/g)).toHaveLength(1);
  });

  it("survives an error that isn't an HttpException at all", () => {
    expect(describeError(new Error("socket hang up"))).toBe("socket hang up");
    // A bare object has no message at all — say so rather than logging the
    // string "undefined", which reads like a real error message.
    expect(describeError({})).toBe("unknown error");
  });
});
