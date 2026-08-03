// Expo config plugin — let Android remember the Comet's USB permission.
//
// Without a USB_DEVICE_ATTACHED intent filter, UsbManager.requestPermission()
// shows a dialog with no "Use by default for this USB device" checkbox. The
// grant then lasts only until the app is restarted, the tablet reboots, or
// the cable is nudged — and the re-prompt appears on a tablet mounted on a
// wall that nobody is looking at. Caller ID silently stops and the shop finds
// out from a customer.
//
// With the filter plus a device_filter.xml naming the box, Android remembers
// the grant permanently and can bring the app forward when the Comet is
// plugged in.
//
// The filter is scoped to the exact hardware — FTDI vendor 0x0403 (1027) with
// Crucible Technologies' custom product ID 0x8e08 (36360) — rather than every
// USB device, so plugging in a printer or a card reader doesn't launch the
// POS.

const { withAndroidManifest, withDangerousMod, AndroidConfig } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

/** FTDI vendor, Comet's custom product ID. Decimal — Android's device_filter
 *  wants decimal, which is a well-known way to lose an afternoon. */
const VENDOR_ID = 1027; // 0x0403
const PRODUCT_ID = 36360; // 0x8e08

const DEVICE_FILTER_XML = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- CTI Comet USB caller-ID unit (Crucible Technologies).
         FTDI silicon with a vendor-specific product ID. -->
    <usb-device vendor-id="${VENDOR_ID}" product-id="${PRODUCT_ID}" />
</resources>
`;

function withDeviceFilterResource(config) {
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      const xmlDir = path.join(
        cfg.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "xml",
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, "usb_device_filter.xml"), DEVICE_FILTER_XML);
      return cfg;
    },
  ]);
}

function withUsbIntentFilter(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    const activity = (app.activity ?? []).find(
      (a) => a?.$?.["android:name"] === ".MainActivity",
    );
    if (!activity) return cfg;

    activity["intent-filter"] = activity["intent-filter"] ?? [];
    const already = activity["intent-filter"].some((f) =>
      (f.action ?? []).some(
        (a) =>
          a?.$?.["android:name"] === "android.hardware.usb.action.USB_DEVICE_ATTACHED",
      ),
    );
    if (!already) {
      activity["intent-filter"].push({
        action: [
          { $: { "android:name": "android.hardware.usb.action.USB_DEVICE_ATTACHED" } },
        ],
      });
    }

    // The filter alone isn't enough — Android needs the resource pointer to
    // know WHICH devices it applies to.
    activity["meta-data"] = activity["meta-data"] ?? [];
    const hasMeta = activity["meta-data"].some(
      (m) =>
        m?.$?.["android:name"] === "android.hardware.usb.action.USB_DEVICE_ATTACHED",
    );
    if (!hasMeta) {
      activity["meta-data"].push({
        $: {
          "android:name": "android.hardware.usb.action.USB_DEVICE_ATTACHED",
          "android:resource": "@xml/usb_device_filter",
        },
      });
    }
    return cfg;
  });
}

module.exports = function withCometUsb(config) {
  return withUsbIntentFilter(withDeviceFilterResource(config));
};
