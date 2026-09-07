import { receiptOrderNumber } from '../receipt-order-number';

// Call RDhsJSAg: the line said "order number 1, 1, 7, 8"; the receipt said
// JVMX7 in both fields. Two halves of a shop, two names for one order.
describe('the number a receipt shows', () => {
  it('prints what the phone customer was told, for a phone order', () => {
    expect(
      receiptOrderNumber({ orderSource: 'VOICE', orderNumber: 1178, displayId: 'JVMX7' }),
    ).toBe(1178);
  });
  it('keeps the short code for every other channel', () => {
    expect(receiptOrderNumber({ orderSource: 'POS', orderNumber: 1179, displayId: 'AB12C' })).toBe(
      'AB12C',
    );
    expect(
      receiptOrderNumber({ orderSource: 'UBER_EATS', orderNumber: null, displayId: '9962' }),
    ).toBe('9962');
  });
  it('falls back sensibly when a field is missing', () => {
    expect(
      receiptOrderNumber({ orderSource: 'VOICE', orderNumber: null, displayId: 'JVMX7' }),
    ).toBe('JVMX7');
    expect(receiptOrderNumber({ orderSource: 'POS', orderNumber: 5, displayId: null })).toBe(5);
  });
});
