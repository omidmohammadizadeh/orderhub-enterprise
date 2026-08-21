// Moved to @orderhub/shared — pricing math lives there so the server and every
// client agree, and so it can be covered by the API test suite (apps/web has
// no test runner). Re-exported here so the existing imports keep working.
export { displayPrice, formatDisplayPrice } from "@orderhub/shared";
export type { DisplayPrice } from "@orderhub/shared";
