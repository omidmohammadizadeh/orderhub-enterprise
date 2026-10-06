// Expo config plugin — one BouncyCastle, not two.
//
// Adding expo-updates broke the Android release build:
//
//   Execution failed for task ':app:checkReleaseDuplicateClasses'.
//   > Duplicate class org.bouncycastle.* found in modules
//       bcprov-jdk15on-1.70.jar     (org.bouncycastle:bcprov-jdk15on:1.70)
//       bcprov-jdk15to18-1.78.1.jar (org.bouncycastle:bcprov-jdk15to18:1.78.1)
//
// Both artifacts are the same library. Upstream renamed `bcprov-jdk15on` to
// `bcprov-jdk15to18` when it dropped old JDK targets, so every class appears
// twice on the classpath and R8 refuses to merge them. expo-updates pulls the
// new name in to verify update signatures; something already in the app (the
// card-reader SDK is the likeliest) still asks for the old one. iOS is
// unaffected — it was the one platform that built.
//
// We drop the OLD artifact and pin the new one. They are the same classes, so
// the library asking for 1.70 gets 1.78.1 and is satisfied; keeping 1.70
// instead would mean shipping the older crypto to satisfy a dead artifact name.
//
// `force` matters as well as `exclude`: without it a transitive bump could
// reintroduce a second version of the SAME artifact later and fail the same
// task again, with a more confusing message.

const { withAppBuildGradle } = require("@expo/config-plugins");

const MARKER = "// orderhub: bouncycastle dedupe";

const BLOCK = `
${MARKER}
configurations.all {
    exclude group: 'org.bouncycastle', module: 'bcprov-jdk15on'
    resolutionStrategy {
        force 'org.bouncycastle:bcprov-jdk15to18:1.78.1'
    }
}
`;

module.exports = function withBouncyCastleDedupe(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error(
        "withBouncyCastleDedupe: app/build.gradle is not Groovy — the dedupe " +
          "block was not applied, and the Android build will fail on duplicate " +
          "BouncyCastle classes.",
      );
    }
    // Prebuild can run more than once against the same file.
    if (cfg.modResults.contents.includes(MARKER)) return cfg;
    cfg.modResults.contents += BLOCK;
    return cfg;
  });
};
