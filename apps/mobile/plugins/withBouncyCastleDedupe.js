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
// BouncyCastle ships a FAMILY of artifacts — bcprov, bcutil, bcpkix, bcpg —
// and every one of them was renamed. Excluding `bcprov-jdk15on` alone just
// moved the failure to `bcutil-jdk15on`, so this substitutes the whole family
// rather than naming members one at a time: any `org.bouncycastle:*-jdk15on`
// is redirected to its `-jdk15to18` twin at a single version.
//
// Substitution, not exclusion. `exclude` only worked for bcprov because
// expo-updates happened to drag the replacement in; for an artifact nothing
// else provides, excluding it would leave the consumer with missing classes at
// runtime instead of a build error. Redirecting always leaves something on the
// classpath that provides them.
//
// Pinning the version here also stops a later transitive bump reintroducing two
// versions of the same artifact and failing the same task with a vaguer message.

const { withAppBuildGradle } = require("@expo/config-plugins");

const MARKER = "// orderhub: bouncycastle dedupe";

const BC_VERSION = "1.78.1";

const BLOCK = `
${MARKER}
configurations.all {
    resolutionStrategy.eachDependency { details ->
        if (details.requested.group == 'org.bouncycastle'
                && details.requested.name.endsWith('-jdk15on')) {
            details.useTarget(
                group: 'org.bouncycastle',
                name: details.requested.name.replace('-jdk15on', '-jdk15to18'),
                version: '${BC_VERSION}'
            )
            details.because('jdk15on was renamed jdk15to18; both on the classpath fails checkReleaseDuplicateClasses')
        }
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
