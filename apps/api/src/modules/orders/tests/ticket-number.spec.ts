import { claimTicketNumber, ticketBusinessDate } from '../ticket-number';

describe('the trading day a ticket number belongs to', () => {
  it('keeps a late London shift on the day it started, until 4am', () => {
    expect(ticketBusinessDate(new Date('2026-11-01T01:30:00Z'), 'Europe/London')).toBe('2026-10-31');
    expect(ticketBusinessDate(new Date('2026-11-01T03:59:00Z'), 'Europe/London')).toBe('2026-10-31');
    expect(ticketBusinessDate(new Date('2026-11-01T04:00:00Z'), 'Europe/London')).toBe('2026-11-01');
  });

  it('uses the shop\'s own clock, not the server\'s', () => {
    // 01:00 UTC is 05:00 in Dubai: already the new day there.
    expect(ticketBusinessDate(new Date('2026-11-01T01:00:00Z'), 'Asia/Dubai')).toBe('2026-11-01');
  });

  it('falls back rather than throwing on a bad timezone', () => {
    expect(ticketBusinessDate(new Date('2026-11-01T12:00:00Z'), 'Not/AZone')).toBe('2026-11-01');
  });
});

describe('claiming a ticket number', () => {
  const makeTx = (query: () => Promise<any>) => {
    const statements: string[] = [];
    return {
      statements,
      tx: {
        $executeRaw: async (parts: TemplateStringsArray) => {
          statements.push(parts.join(''));
          return 0;
        },
        $queryRaw: query,
      } as any,
    };
  };

  it('returns the claimed number', async () => {
    const { tx } = makeTx(async () => [{ lastValue: 7 }]);
    await expect(claimTicketNumber(tx, 'loc', '2026-11-01', jest.fn())).resolves.toBe(7);
  });

  it('never fails the order: rolls back to its savepoint and returns null', async () => {
    const { tx, statements } = makeTx(async () => {
      throw new Error('relation does not exist');
    });
    const onError = jest.fn();
    await expect(claimTicketNumber(tx, 'loc', '2026-11-01', onError)).resolves.toBeNull();
    expect(onError).toHaveBeenCalled();
    expect(statements.at(-1)).toContain('ROLLBACK TO SAVEPOINT');
  });

  it('survives even the savepoint itself failing', async () => {
    const tx = {
      $executeRaw: () => Promise.reject(new Error('connection lost')),
      $queryRaw: jest.fn(),
    } as any;
    await expect(claimTicketNumber(tx, 'loc', '2026-11-01', jest.fn())).resolves.toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
