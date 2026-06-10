-- Phase AP-8 — AUTHORIZED PaymentStatus for the manual-capture flow.
--
-- Customer pays through Stripe Checkout (capture_method=manual). Stripe
-- holds the funds on the card and emits payment_intent.amount_capturable_updated.
-- We mark the Order.paymentStatus = AUTHORIZED at that point. Restaurant
-- accepts -> we call PaymentIntent.capture() -> paymentStatus -> PAID.
-- Restaurant rejects -> we call PaymentIntent.cancel() -> paymentStatus -> FAILED.

ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'AUTHORIZED';
