-- Phase AX — the notification's tap target, supplied by the browser that
-- subscribed. The server-derived path 404'd whenever a location had no slug.
ALTER TABLE "customer_push_orders" ADD COLUMN "trackPath" TEXT;
