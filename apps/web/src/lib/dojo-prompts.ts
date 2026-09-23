// Dojo terminal notificationEvents → what the till shows while waiting.
// Shared by taking a payment (charge-reader-modal) and giving one back
// (dojo-refund-panel) — the machine sends the same events either way.
export const DOJO_PROMPTS: Record<string, string> = {
  PresentCard: "Customer: tap, insert or swipe your card",
  PresentOnlyOneCard: "Present only one card",
  InsertCard: "Customer: insert your card",
  ReEnterCard: "Please present the card again",
  EnterPin: "Customer is entering their PIN…",
  RemoveCard: "Customer: remove your card",
  PleaseWait: "Processing — please wait…",
  CardUnsupported: "That card isn't supported — try another card",
  CardError: "Card error — try the card again",
  Approved: "Approved — confirming…",
  Declined: "Declined on the machine",
};
