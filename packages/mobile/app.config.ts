import type { ExpoConfig } from "expo/config";

const pairingScheme = "nodex-mobile";
const cameraPermission = "Allow Nodex to scan a pairing code from your desktop.";

const variants = {
  development: {
    name: "Nodex Dev",
    identifier: "app.jyu.nodex.mobile.dev",
    schemes: ["nodex-mobile-dev", pairingScheme],
  },
  production: {
    name: "Nodex",
    identifier: "app.jyu.nodex.mobile",
    schemes: [pairingScheme],
  },
} as const;

const variant = process.env.APP_VARIANT ?? "development";
if (variant !== "development" && variant !== "production") {
  throw new Error("APP_VARIANT must be development or production.");
}
const { name, identifier, schemes } = variants[variant];

export default {
  name,
  slug: "nodex-mobile",
  version: "0.1.0",
  platforms: ["ios", "android"],
  scheme: [...schemes],
  userInterfaceStyle: "automatic",
  orientation: "portrait",
  icon: "./assets/icon.png",
  ios: {
    icon: "./assets/app-icon.icon",
    bundleIdentifier: identifier,
    appleTeamId: process.env.APPLE_TEAM_ID,
    entitlements: {
      // An approval holds a Run until answered, so it may break through Focus.
      "com.apple.developer.usernotifications.time-sensitive": true,
    },
    infoPlist: {
      NSLocalNetworkUsageDescription:
        "Allow Nodex to connect to your desktop on the local network.",
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    },
  },
  android: {
    package: identifier,
    // Unsent captures and what a phone last saw stay on the phone, and its keys cannot be restored.
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
    "./plugins/withAndroidCleartext.cjs",
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
