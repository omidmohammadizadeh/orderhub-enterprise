-- How a driver's phone wants job alerts: "data" = data-only push the app presents
-- itself (Android driver app 1.0.4+), null = the ordinary alert push.
ALTER TABLE "driver_presence" ADD COLUMN "pushJobFormat" TEXT;
