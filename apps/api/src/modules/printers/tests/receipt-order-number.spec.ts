import { receiptOrderNumber } from '../receipt-order-number';

// Call RDhsJSAg: the line said "order number 1, 1, 7, 8"; the receipt said
// JVMX7. Call laylhxjw: the line said the sequential number; the board said
// #4J79Y. One reference everywhere: the one the board shows.
describe('the number a receipt shows', () => {
  it('prints what the board shows, for a phone order too', () => {
    expect(
      receiptOrderNumber({ orderSource: 'VOICE', orderNumber: 1178, displayId: 'JVMX7' }),
    ).toBe('JVMX7');
  });
  it('keeps the short code for every other channel', () => {
    expect(receiptOrderNumber({ orderSource: 'POS', orderNumber: 1179, displayId: 'AB12C' })).toBe(
      'AB12C',
    );
    expect(
      receiptOrderNumber({ orderSource: 'UBER_EATS', orderNumber: null, displayId: '9962' }),
    ).toBe('9962');
  });
  it('falls back to the sequential number when there is no code', () => {
    expect(receiptOrderNumber({ orderSource: 'VOICE', orderNumber: 1178, displayId: null })).toBe(
      1178,
    );
    expect(receiptOrderNumber({ orderSource: 'POS', orderNumber: 5, displayId: null })).toBe(5);
    expect(receiptOrderNumber({ orderSource: 'POS', orderNumber: null, displayId: null })).toBeNull();
  });
});
