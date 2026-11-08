const { withAppBuildGradle } = require("expo/config-plugins");

/**
 * Release builds sign with the Nodex keystore when the release pipeline supplies it, so every APK
 * a person installs can update the last. Without it, as in a local `android:release`, they keep
 * the template's debug signing, which the release pipeline refuses to publish.
 */
const marker = "// Nodex release signing";

const releaseSigningConfig = `        release {
            ${marker}: the keystore and its password come from the release pipeline.
            def keystore = System.getenv("NODEX_ANDROID_KEYSTORE")
            if (keystore) {
                storeFile file(keystore)
                storePassword System.getenv("NODEX_ANDROID_KEYSTORE_PASSWORD")
                keyAlias "nodex"
                keyPassword System.getenv("NODEX_ANDROID_KEYSTORE_PASSWORD")
            }
        }
`;

const templateReleaseSigning =
  /(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/u;

function withReleaseSigning(gradle) {
  if (gradle.includes(marker)) return gradle;
  const signingConfigs = /( {4}signingConfigs \{\n)/u;
  if (!signingConfigs.test(gradle) || !templateReleaseSigning.test(gradle))
    throw new Error("The Android app build no longer has the template's signing configuration.");
  return gradle
    .replace(signingConfigs, `$1${releaseSigningConfig}`)
    .replace(
      templateReleaseSigning,
      '$1signingConfig System.getenv("NODEX_ANDROID_KEYSTORE") ? signingConfigs.release : signingConfigs.debug',
    );
}

module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    config.modResults.contents = withReleaseSigning(config.modResults.contents);
    return config;
  });
};

module.exports.withReleaseSigning = withReleaseSigning;
