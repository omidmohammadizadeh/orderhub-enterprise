import { BadRequestException } from "@nestjs/common";
import { SmsService } from "../sms.service";
import * as provider from "../sms-provider";

jest.mock("../sms-provider", () => ({
  isSmsConfigured: jest.fn(() => true),
  smsProvider: jest.fn(() => "twilio"),
  smsConfigHint: jest.fn(() => "TWILIO_*"),
  defaultSmsFrom: jest.fn(() => "+441613334444"),
  sendSmsViaProvider: jest.fn(async () => ({ id: "SM1", segments: 1 })),
}));

const sendSpy = provider.sendSmsViaProvider as jest.Mock;

function build(locationSettings: Record<string, unknown> | null = null) {
  const prisma: any = {
    location: { findUnique: jest.fn(async () => ({ settings: locationSettings })) },
    smsMessage: { create: jest.fn(async () => ({ id: "msg-1" })) },
  };
  const wallet: any = {
    assertCanAffordSms: jest.fn(async () => undefined),
    debitForSms: jest.fn(async () => undefined),
  };
  return { svc: new SmsService(prisma, wallet), prisma, wallet };
}

const base = {
  tenantId: "t1",
  body: "Pay here",
  purpose: "PAYMENT_LINK" as const,
  bill: false,
};

beforeEach(() => jest.clearAllMocks());

describe("SmsService.send — recipient normalisation", () => {
  it("converts a UK national number to E.164 before calling the provider", async () => {
    const { svc } = build();
    await svc.send({ ...base, to: "07788187123" });
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+447788187123" }),
    );
  });

  it("normalises a number typed with spaces and brackets", async () => {
    const { svc } = build();
    await svc.send({ ...base, to: " (07788) 187 123 " });
    expect(sendSpy.mock.calls[0][0].to).toBe("+447788187123");
  });

  it("refuses an unusable number without calling the provider", async () => {
    const { svc } = build();
    await expect(svc.send({ ...base, to: "n/a" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("logs the normalised number, so the ledger matches what was dialled", async () => {
    const { svc, prisma } = build();
    await svc.send({ ...base, to: "07788187123" });
    expect(prisma.smsMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ toNumber: "+447788187123" }),
      }),
    );
  });
});

describe("SmsService.send — sender name", () => {
  it("sends from the shop's name when the location has one", async () => {
    const { svc } = build({ smsSenderName: "PizzaUno" });
    await svc.send({ ...base, to: "07788187123", locationId: "loc-1" });
    expect(sendSpy.mock.calls[0][0].from).toBe("PizzaUno");
  });

  it("trims a too-long name to the carrier limit instead of failing the send", async () => {
    const { svc } = build({ smsSenderName: "Pizza Uno Manchester" });
    await svc.send({ ...base, to: "07788187123", locationId: "loc-1" });
    expect(sendSpy.mock.calls[0][0].from).toBe("Pizza Uno M");
  });

  it("strips characters the carrier rejects rather than blocking collection", async () => {
    const { svc } = build({ smsSenderName: "Jinty's Pizza" });
    await svc.send({ ...base, to: "07788187123", locationId: "loc-1" });
    expect(sendSpy.mock.calls[0][0].from).toBe("Jinty s Piz");
  });

  it("falls back to the shop number when the name is unusable", async () => {
    const { svc } = build({ smsSenderName: "!!!", smsNumber: "+441619998888" });
    await svc.send({ ...base, to: "07788187123", locationId: "loc-1" });
    expect(sendSpy.mock.calls[0][0].from).toBe("+441619998888");
  });

  it("still uses the number, never the name, for marketing", async () => {
    const { svc } = build({ smsSenderName: "PizzaUno", smsNumber: "+441619998888" });
    await svc.send({
      ...base,
      purpose: "MARKETING",
      to: "07788187123",
      locationId: "loc-1",
    });
    expect(sendSpy.mock.calls[0][0].from).toBe("+441619998888");
  });

  it("normalises a shop number typed in national format", async () => {
    const { svc } = build({ smsNumber: "0161 999 8888" });
    await svc.send({ ...base, to: "07788187123", locationId: "loc-1" });
    expect(sendSpy.mock.calls[0][0].from).toBe("+441619998888");
  });
});
