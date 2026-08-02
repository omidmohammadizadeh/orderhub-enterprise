import { WalletService } from "../wallet.service";

// The voice money layer, tested at the seams that actually cost someone money:
// what counts as billable, and whether an empty wallet can take the phone
// offline without warning.
//
// Prisma and Stripe are stubbed — these are decision tests, not integration
// tests. The parts that need a real database (the unique index that makes
// double-billing impossible) are called out in the last block.

const makeService = (overrides: {
  wallet?: Record<string, unknown>;
  env?: Record<string, string>;
  stripe?: unknown;
}) => {
  const wallet = {
    id: "wal_1",
    tenantId: "ten_1",
    locationId: "loc_1",
    balanceMinor: 1000,
    currency: "GBP",
    voicePricePerCallMinor: null,
    autoTopupEnabled: false,
    autoTopupThresholdMinor: 1000,
    autoTopupAmountMinor: 2000,
    stripeCustomerId: null,
    stripePaymentMethodId: null,
    autoTopupLastAt: null,
    ...overrides.wallet,
  };
  const prisma: any = {
    wallet: {
      findFirst: jest.fn().mockResolvedValue(wallet),
      create: jest.fn().mockResolvedValue(wallet),
      update: jest.fn().mockImplementation(({ data }: any) => {
        Object.assign(wallet, data);
        return Promise.resolve(wallet);
      }),
      findUnique: jest.fn().mockResolvedValue(wallet),
    },
  };
  const config = { get: (k: string) => overrides.env?.[k] };
  const svc = new WalletService(prisma as any, config as any);
  // The constructor builds its own Stripe client from env; replace it.
  (svc as any).stripe = overrides.stripe ?? null;
  return { svc, wallet, prisma };
};

describe("voice call pricing", () => {
  it("defaults to £1 per answered call", () => {
    const { svc } = makeService({});
    expect(svc.voicePricePerCallMinor(null)).toBe(100);
  });

  it("lets a wallet override the platform rate (founding-customer pricing)", () => {
    const { svc } = makeService({});
    expect(svc.voicePricePerCallMinor({ voicePricePerCallMinor: 50 })).toBe(50);
  });

  it("honours the env override", () => {
    const { svc } = makeService({ env: { VOICE_PRICE_PER_CALL_MINOR: "75" } });
    expect(svc.voicePricePerCallMinor(null)).toBe(75);
  });
});

describe("what counts as a billable call", () => {
  const { svc } = makeService({});

  it("does NOT bill a wrong number that hangs up immediately", () => {
    expect(svc.isBillableCall({ status: "COMPLETED", durationSeconds: 3 })).toBe(false);
  });

  it("does NOT bill a call the AI never answered", () => {
    expect(svc.isBillableCall({ status: "NOT_ANSWERED", durationSeconds: 0 })).toBe(false);
  });

  it("does NOT bill a call that failed on our side", () => {
    expect(svc.isBillableCall({ status: "FAILED", durationSeconds: 45 })).toBe(false);
  });

  it("bills a real conversation", () => {
    expect(svc.isBillableCall({ status: "COMPLETED", durationSeconds: 95 })).toBe(true);
  });

  it("bills a call handed to a human — the AI still did the triage", () => {
    expect(svc.isBillableCall({ status: "TRANSFERRED", durationSeconds: 22 })).toBe(true);
  });

  it("bills exactly at the threshold, not a second later", () => {
    expect(svc.isBillableCall({ status: "COMPLETED", durationSeconds: 10 })).toBe(true);
    expect(svc.isBillableCall({ status: "COMPLETED", durationSeconds: 9 })).toBe(false);
  });
});

describe("the empty-wallet gate", () => {
  it("answers when the balance covers a call", async () => {
    const { svc } = makeService({ wallet: { balanceMinor: 500 } });
    const verdict = await svc.canAnswerVoiceCall("ten_1", "loc_1");
    expect(verdict.ok).toBe(true);
  });

  it("refuses — without throwing — when the balance is short", async () => {
    const { svc } = makeService({ wallet: { balanceMinor: 40 } });
    const verdict = await svc.canAnswerVoiceCall("ten_1", "loc_1");
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("NO_FUNDS");
  });

  it("refuses at exactly one penny short", async () => {
    const { svc } = makeService({ wallet: { balanceMinor: 99 } });
    expect((await svc.canAnswerVoiceCall("ten_1", "loc_1")).ok).toBe(false);
  });

  it("rescues the call with an auto top-up rather than letting the phone go quiet", async () => {
    const stripe = {
      paymentIntents: {
        create: jest.fn().mockResolvedValue({ id: "pi_1", status: "succeeded", amount: 2000 }),
      },
    };
    const { svc, wallet } = makeService({
      wallet: {
        balanceMinor: 20,
        autoTopupEnabled: true,
        stripeCustomerId: "cus_1",
        stripePaymentMethodId: "pm_1",
      },
      stripe,
    });
    // creditFromStripePi does the real crediting; stub it to the balance move.
    jest.spyOn(svc, "creditFromStripePi").mockImplementation(async () => {
      wallet.balanceMinor += 2000;
    });

    const verdict = await svc.canAnswerVoiceCall("ten_1", "loc_1");

    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(stripe.paymentIntents.create.mock.calls[0][0]).toMatchObject({
      off_session: true,
      confirm: true,
    });
    expect(verdict.ok).toBe(true);
  });

  it("still refuses cleanly when the saved card declines", async () => {
    const stripe = {
      paymentIntents: { create: jest.fn().mockRejectedValue(new Error("card_declined")) },
    };
    const { svc, wallet } = makeService({
      wallet: {
        balanceMinor: 20,
        autoTopupEnabled: true,
        stripeCustomerId: "cus_1",
        stripePaymentMethodId: "pm_1",
      },
      stripe,
    });

    const verdict = await svc.canAnswerVoiceCall("ten_1", "loc_1");

    expect(verdict.ok).toBe(false);
    // The decline must be recorded on the wallet, not just logged — otherwise
    // the first anyone knows is the phone not being answered.
    expect(wallet.autoTopupFailedAt).toBeTruthy();
    expect(String(wallet.autoTopupFailureReason)).toContain("card_declined");
  });

  it("does not charge the card twice inside the cooldown", async () => {
    const stripe = {
      paymentIntents: {
        create: jest.fn().mockResolvedValue({ id: "pi_1", status: "succeeded", amount: 2000 }),
      },
    };
    const { svc, wallet } = makeService({
      wallet: {
        balanceMinor: 20,
        autoTopupEnabled: true,
        stripeCustomerId: "cus_1",
        stripePaymentMethodId: "pm_1",
        autoTopupLastAt: new Date(),
      },
      stripe,
    });
    jest.spyOn(svc, "creditFromStripePi").mockResolvedValue(undefined);

    await svc.canAnswerVoiceCall("ten_1", "loc_1");

    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(wallet.balanceMinor).toBe(20);
  });

  it("does nothing when auto top-up is off — no surprise charges", async () => {
    const stripe = { paymentIntents: { create: jest.fn() } };
    const { svc } = makeService({
      wallet: {
        balanceMinor: 20,
        autoTopupEnabled: false,
        stripeCustomerId: "cus_1",
        stripePaymentMethodId: "pm_1",
      },
      stripe,
    });

    const verdict = await svc.canAnswerVoiceCall("ten_1", "loc_1");

    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(verdict.ok).toBe(false);
  });
});

describe("auto top-up settings", () => {
  it("refuses to enable without a card on file", async () => {
    const { svc } = makeService({ wallet: { stripePaymentMethodId: null } });
    await expect(
      svc.setAutoTopup("ten_1", "loc_1", { enabled: true }),
    ).rejects.toThrow(/Add a card first/);
  });

  it("refuses a top-up amount below the Stripe minimum", async () => {
    const { svc } = makeService({ wallet: { stripePaymentMethodId: "pm_1" } });
    await expect(
      svc.setAutoTopup("ten_1", "loc_1", { enabled: true, amountMinor: 100 }),
    ).rejects.toThrow(/Minimum auto top-up/);
  });

  it("clears a previous failure when re-enabled with a new card", async () => {
    const { svc, wallet } = makeService({
      wallet: {
        stripePaymentMethodId: "pm_2",
        autoTopupFailedAt: new Date(),
        autoTopupFailureReason: "card_declined",
      },
    });
    await svc.setAutoTopup("ten_1", "loc_1", { enabled: true });
    expect(wallet.autoTopupFailedAt).toBeNull();
    expect(wallet.autoTopupFailureReason).toBeNull();
  });
});

// Not covered here, and deliberately so: "one call, one charge" is enforced by
// the unique index on wallet_transactions.voiceCallId, and debitForVoiceCall
// creates the ledger row BEFORE moving the balance so a duplicate is rejected
// before any money moves. That guarantee lives in Postgres, so proving it needs
// a real database — it belongs in an integration test, not a stub.
