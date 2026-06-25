// Expo config plugin — make the iOS build iPad-only.
//
// Expo's managed `ios.supportsTablet: true` produces TARGETED_DEVICE_FAMILY
// "1,2" (iPhone + iPad). There's no managed option for iPad-only, so we set
// TARGETED_DEVICE_FAMILY = "2" on the app target's build configs directly.
// This keeps the app off iPhone in the App Store.

const { withXcodeProject } = require("@expo/config-plugins");

module.exports = function withIpadOnly(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const configurations = project.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configurations)) {
      const entry = configurations[key];
      const buildSettings = entry && entry.buildSettings;
      // Only the app target's configs carry a bundle id — skip pods/other.
      if (buildSettings && buildSettings.PRODUCT_BUNDLE_IDENTIFIER) {
        buildSettings.TARGETED_DEVICE_FAMILY = "2"; // 1 = iPhone, 2 = iPad
      }
    }
    return cfg;
  });
};
