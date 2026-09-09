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

// Reserving the price at answer time, rather than checking it then charging at
// hangup. The old order left a window: two calls landing together both saw the
// same credit, both were answered, and both were charged, so a shop holding
// exactly one call's credit finished the evening owing us one.
describe("reserving a call's price before answering", () => {
  const makeWalletWorld = (startingBalance: number) => {
    const wallet: any = {
      id: "wal_1",
      tenantId: "ten_1",
      locationId: "loc_1",
      balanceMinor: startingBalance,
      currency: "GBP",
      voicePricePerCallMinor: null,
      autoTopupEnabled: false,
      autoTopupThresholdMinor: 0,
      autoTopupAmountMinor: 2000,
      stripeCustomerId: null,
      stripePaymentMethodId: null,
      autoTopupLastAt: null,
    };
    const ledger = new Map<string, any>();
    const voiceCalls = new Map<string, any>();
    const tx: any = {
      wallet: {
        findFirst: jest.fn(async () => wallet),
        findUnique: jest.fn(async () => wallet),
        create: jest.fn(async () => wallet),
        update: jest.fn(async ({ data }: any) => {
          if (data?.balanceMinor?.decrement != null)
            wallet.balanceMinor -= data.balanceMinor.decrement;
          else if (data?.balanceMinor?.increment != null)
            wallet.balanceMinor += data.balanceMinor.increment;
          else Object.assign(wallet, data);
          return wallet;
        }),
        // The conditional decrement is the whole mechanism: a wallet drained
        // by a call we raced does not match, and count comes back 0.
        updateMany: jest.fn(async ({ where, data }: any) => {
          const floor = where?.balanceMinor?.gte ?? 0;
          if (wallet.balanceMinor < floor) return { count: 0 };
          wallet.balanceMinor -= data.balanceMinor.decrement;
          return { count: 1 };
        }),
      },
      walletTransaction: {
        create: jest.fn(async ({ data }: any) => {
          if (data.voiceCallId && ledger.has(data.voiceCallId)) {
            const err: any = new Error("unique");
            err.code = "P2002";
            throw err;
          }
          if (data.voiceCallId) ledger.set(data.voiceCallId, data);
          return data;
        }),
        findUnique: jest.fn(async ({ where }: any) =>
          ledger.get(where.voiceCallId) ?? null,
        ),
        deleteMany: jest.fn(async ({ where }: any) =>
          ledger.delete(where.voiceCallId) ? { count: 1 } : { count: 0 },
        ),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      voiceCall: {
        update: jest.fn(async ({ where, data }: any) => {
          voiceCalls.set(where.id, data);
          return data;
        }),
      },
    };
    tx.$transaction = jest.fn(async (cb: any) => cb(tx));
    const svc = new WalletService(tx as any, { get: () => undefined } as any);
    (svc as any).stripe = null;
    return { svc, wallet, ledger, voiceCalls };
  };

  it("takes the price out of the wallet before the call is answered", async () => {
    const { svc, wallet, ledger } = makeWalletWorld(100);
    const v = await svc.reserveForVoiceCall({
      tenantId: "ten_1",
      locationId: "loc_1",
      voiceCallId: "call_1",
    });
    expect(v.ok).toBe(true);
    expect(wallet.balanceMinor).toBe(0);
    expect(ledger.get("call_1").amountMinor).toBe(-100);
  });

  it("refuses the second of two calls racing for one call's credit", async () => {
    const { svc, wallet } = makeWalletWorld(100);
    const first = await svc.reserveForVoiceCall({
      tenantId: "ten_1",
      locationId: "loc_1",
      voiceCallId: "call_1",
    });
    const second = await svc.reserveForVoiceCall({
      tenantId: "ten_1",
      locationId: "loc_1",
      voiceCallId: "call_2",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("NO_FUNDS");
    // Never negative — that was the whole bug.
    expect(wallet.balanceMinor).toBe(0);
  });

  it("does not charge a second time when a reserved call is settled", async () => {
    const { svc, wallet, voiceCalls } = makeWalletWorld(500);
    await svc.reserveForVoiceCall({
      tenantId: "ten_1",
      locationId: "loc_1",
      voiceCallId: "call_1",
    });
    expect(wallet.balanceMinor).toBe(400);
    const charged = await svc.debitForVoiceCall({
      tenantId: "ten_1",
      locationId: "loc_1",
      voiceCallId: "call_1",
      durationSeconds: 95,
      status: "COMPLETED",
    });
    expect(charged).toEqual({ chargedMinor: 100 });
    expect(wallet.balanceMinor).toBe(400);
    expect(voiceCalls.get("call_1").billedMinor).toBe(100);
  });

  it("gives the money back when the call turns out not to be billable", async () => {
    const { svc, wallet, ledger } = makeWalletWorld(500);
    await svc.reserveForVoiceCall({
      tenantId: "ten_1",
      locationId: "loc_1",
      voiceCallId: "call_1",
    });
    expect(wallet.balanceMinor).toBe(400);
    const charged = await svc.debitForVoiceCall({
      tenantId: "ten_1",
      locationId: "loc_1",
      voiceCallId: "call_1",
      durationSeconds: 3,
      status: "COMPLETED",
    });
    expect(charged).toBeNull();
    expect(wallet.balanceMinor).toBe(500);
    // And no statement line for a charge that was undone.
    expect(ledger.has("call_1")).toBe(false);
  });

  it("still charges at hangup for a call answered without a reservation", async () => {
    const { svc, wallet } = makeWalletWorld(500);
    const charged = await svc.debitForVoiceCall({
      tenantId: "ten_1",
      locationId: "loc_1",
      voiceCallId: "legacy_call",
      durationSeconds: 60,
      status: "COMPLETED",
    });
    expect(charged).toEqual({ chargedMinor: 100 });
    expect(wallet.balanceMinor).toBe(400);
  });
});

// Per-shop call pricing. Founding shops and franchise groups get a rate we
// agreed by hand, and until this existed the only record of it was a database
// update — so the agreed price lived in somebody's memory until it didn't.
describe("setting a shop's own call price", () => {
  const world = () => {
    const wallet: any = {
      id: "wal_1",
      tenantId: "ten_1",
      locationId: "loc_1",
      balanceMinor: 1000,
      currency: "GBP",
      voicePricePerCallMinor: null,
    };
    const prisma: any = {
      wallet: {
        findFirst: jest.fn(async () => wallet),
        findUnique: jest.fn(async () => wallet),
        create: jest.fn(async () => wallet),
        update: jest.fn(async ({ data }: any) => {
          Object.assign(wallet, data);
          return wallet;
        }),
      },
    };
    const svc = new WalletService(prisma as any, { get: () => undefined } as any);
    (svc as any).stripe = null;
    return { svc, wallet };
  };

  it("records an agreed founding rate", async () => {
    const { svc, wallet } = world();
    await svc.setVoicePrice("ten_1", "loc_1", 50);
    expect(wallet.voicePricePerCallMinor).toBe(50);
    expect(svc.voicePricePerCallMinor(wallet)).toBe(50);
  });

  it("clears the override and returns them to the standard rate", async () => {
    const { svc, wallet } = world();
    await svc.setVoicePrice("ten_1", "loc_1", 50);
    await svc.setVoicePrice("ten_1", "loc_1", null);
    expect(wallet.voicePricePerCallMinor).toBeNull();
    expect(svc.voicePricePerCallMinor(wallet)).toBe(100);
  });

  it("allows a free shop", async () => {
    const { svc, wallet } = world();
    await svc.setVoicePrice("ten_1", "loc_1", 0);
    expect(svc.voicePricePerCallMinor(wallet)).toBe(0);
  });

  it("refuses pounds typed into a pence field", async () => {
    // Someone entering "50" meaning fifty pounds would bill £50 a call, and
    // the shop would find out on their statement.
    const { svc } = world();
    await expect(svc.setVoicePrice("ten_1", "loc_1", 5000)).rejects.toThrow(/PENCE/);
  });

  it("refuses a negative or fractional price", async () => {
    const { svc } = world();
    await expect(svc.setVoicePrice("ten_1", "loc_1", -1)).rejects.toThrow();
    await expect(svc.setVoicePrice("ten_1", "loc_1", 12.5)).rejects.toThrow();
  });
});
