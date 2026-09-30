// Moved to @orderhub/shared so the till reads an order's address exactly the
// way the driver app does — see packages/shared/src/lib/delivery-address.ts.
// Re-exported here because "where is this order going" is an orders concept,
// and the callers that already ask this module shouldn't have to care that
// the answer now also serves the browser.
export {
  resolveDeliveryAddress,
  formatDeliveryAddress,
  coordsFromDeliveryAddress,
} from "@orderhub/shared";
export type {
  DeliveryAddressParts,
  OrderAddressSource,
} from "@orderhub/shared";
