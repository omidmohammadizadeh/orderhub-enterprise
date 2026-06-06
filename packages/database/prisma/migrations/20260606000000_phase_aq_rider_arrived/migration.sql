-- Phase AQ — RIDER_ARRIVED order status.
--
-- New stage between ACCEPTED_BY_DRIVER and OUT_FOR_DELIVERY. Used for
-- platform-fulfilled delivery orders (Uber Eats / Just Eat / Deliveroo /
-- Stuart / Uber Direct) to signal that the courier has physically reached
-- the shop and is waiting to collect — front-of-house gets an audible
-- alert and hands over the bag.
--
-- ALTER TYPE ... ADD VALUE is a no-data-loss operation in Postgres and
-- runs in a single statement. No backfill needed; existing rows keep
-- their current status.

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'RIDER_ARRIVED';
