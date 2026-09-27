// Expo config plugin — the camera is OPTIONAL hardware.
//
// Declaring the CAMERA permission (1.2.1, camera barcode scanning at the till)
// makes Google Play assume the app REQUIRES a camera: it adds implied
// <uses-feature android.hardware.camera required=true> (+ autofocus) and hides
// the app from every device without one. On the first production release that
// was 345 device models — countertop POS terminals (Sunmi T2/D2 have no
// camera) among them, whose existing installs would silently stop updating.
//
// Marking both features required="false" keeps the app on those devices. The
// till offers "Scan with camera" only where a camera exists; everyone else
// scans with a USB/Bluetooth scanner, which needs no camera at all.

const { withAndroidManifest } = require("@expo/config-plugins");

const OPTIONAL_FEATURES = ["android.hardware.camera", "android.hardware.camera.autofocus"];

module.exports = function withOptionalCamera(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const features = (manifest["uses-feature"] = manifest["uses-feature"] ?? []);
    for (const name of OPTIONAL_FEATURES) {
      const existing = features.find((f) => f?.$?.["android:name"] === name);
      if (existing) {
        existing.$["android:required"] = "false";
      } else {
        features.push({ $: { "android:name": name, "android:required": "false" } });
      }
    }
    return cfg;
  });
};
