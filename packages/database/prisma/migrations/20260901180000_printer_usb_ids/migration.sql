-- USB printers are addressed by vendor + product id, the way a LAN printer is
-- addressed by host + port. The print bridge's USB transport already needed
-- these; they existed only in the bridge's local config.json, so a cabled
-- printer could not be configured from the dashboard.
ALTER TABLE "printers" ADD COLUMN "usbVendor" INTEGER;
ALTER TABLE "printers" ADD COLUMN "usbProduct" INTEGER;
