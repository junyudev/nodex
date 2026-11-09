import type { ExpoConfig } from "expo/config";

import { version as desktopVersion } from "../../package.json";

const pairingScheme = "nodex-mobile";
const cameraPermission = "Allow Nodex to scan a Space device link.";

const variants = {
  development: {
    name: "Nodex Dev",
    identifier: "app.jyu.nodex.mobile.dev",
    schemes: ["nodex-mobile-dev", pairingScheme],
  },
  "tls-proof": {
    name: "Nodex TLS Proof",
    identifier: "app.jyu.nodex.mobile.tlsproof",
    schemes: ["nodex-mobile-tls-proof"],
  },
  production: {
    name: "Nodex",
    identifier: "app.jyu.nodex.mobile",
    schemes: [pairingScheme],
  },
} as const;

const variant = process.env.APP_VARIANT ?? "development";
if (variant !== "development" && variant !== "production" && variant !== "tls-proof") {
  throw new Error("APP_VARIANT must be development, production or tls-proof.");
}
const { name, identifier, schemes } = variants[variant];

// A release stamps the phone app with the desktop release it ships beside; see
// scripts/release/mobile.ts. Development builds take the source version and the first build.
const version = process.env.NODEX_MOBILE_VERSION ?? desktopVersion;
const iosBuild = process.env.NODEX_MOBILE_IOS_BUILD ?? "1";
const androidVersionCode = Number(process.env.NODEX_MOBILE_ANDROID_VERSION_CODE ?? "1");

export default {
  name,
  slug: "nodex-mobile",
  version,
  platforms: ["ios", "android"],
  scheme: [...schemes],
  userInterfaceStyle: "automatic",
  orientation: "portrait",
  icon: "./assets/icon.png",
  ios: {
    icon: "./assets/app-icon.icon",
    bundleIdentifier: identifier,
    appleTeamId: process.env.APPLE_TEAM_ID,
    buildNumber: iosBuild,
    entitlements: {
      // An approval holds a Run until answered, so it may break through Focus.
      "com.apple.developer.usernotifications.time-sensitive": true,
    },
    infoPlist: {
      NSLocalNetworkUsageDescription: "Allow Nodex to connect to Space hosts on the local network.",
      // ATS governs the URL Loading System. Space hosts are reached only through the pinned
      // Network.framework transport (modules/pinned-tls), which ATS does not evaluate, so a
      // self-signed host works at any address without loosening ATS for anything else.
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      // What App Store Connect records for standard encryption on a store without France's rules.
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: identifier,
    // An installed APK only takes an update with a higher version code.
    versionCode: androidVersionCode,
    // Unsent captures and what a phone last saw stay on the phone, and its Device credentials cannot be restored.
    allowBackup: false,
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-foreground.png",
      monochromeImage: "./assets/adaptive-monochrome.png",
      backgroundColor: "#ffffff",
    },
  },
  plugins: [
    // Xcode mods run in reverse order; copy the app's final build settings after the other plugins.
    "./plugins/withNotificationDecryption.cjs",
    "./plugins/withAndroidReleaseSigning.cjs",
    [
      "expo-build-properties",
      {
        android: {
          // The Markdown renderer reflects on this class, but its own rules name another package.
          // Without this, block math silently disappears from minified builds.
          extraProguardRules:
            "-keep class com.swmansion.enriched.markdown.segments.MathContainerView { *; }",
        },
      },
    ],
    // The accent tokens in src/ui/theme.css.
    ["./plugins/withAndroidAccent.cjs", { light: "#3560e0", dark: "#4d72ee" }],
    ["expo-dev-client", { addGeneratedScheme: false }],
    ["expo-camera", { cameraPermission, microphonePermission: false, recordAudioAndroid: false }],
    [
      "expo-image-picker",
      {
        photosPermission: "Allow Nodex to attach photos from your library.",
        cameraPermission,
        microphonePermission: false,
      },
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/splash.png",
        imageWidth: 128,
        backgroundColor: "#ffffff",
        dark: { backgroundColor: "#000000" },
      },
    ],
    ["expo-secure-store", { faceIDPermission: false }],
    ["expo-notifications", { mode: variant === "development" ? "development" : "production" }],
  ],
  experiments: { onDemandFilesystem: true },
  extra: {
    pushKeychainGroup: process.env.APPLE_TEAM_ID
      ? `${process.env.APPLE_TEAM_ID}.${identifier}.push`
      : null,
  },
} satisfies ExpoConfig;
