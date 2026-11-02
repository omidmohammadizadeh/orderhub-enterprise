import { renderToEscPos } from '../escpos-renderer';

const text = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('latin1');
const payload = { orderId: 'o1', displayId: 'AB12C', items: [], customerName: 'Sam' };

describe('the ticket number on a printed ticket', () => {
  it('prints above the Order ID, which stays on the ticket', () => {
    const out = text(renderToEscPos({ ...payload, ticketNumber: 12 } as any, { paperWidth: 80 } as any));
    expect(out).toContain('TICKET 12');
    expect(out).toContain('#AB12C');
    expect(out.indexOf('TICKET 12')).toBeLessThan(out.indexOf('#AB12C'));
  });

  it('leaves it off an older order that has none', () => {
    const out = text(renderToEscPos({ ...payload, ticketNumber: null } as any, { paperWidth: 80 } as any));
    expect(out).not.toContain('TICKET');
    expect(out).toContain('#AB12C');
  });
});
